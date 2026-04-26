/// <reference types="@cloudflare/workers-types" />
import type { BunToWorker, Card, CardStatus, ChannelEvent, WorkerToBun } from '@kanban/protocol'
import { PROTOCOL_VERSION, canTransition } from '@kanban/protocol'
import type { Env } from './types.ts'

interface BunConn {
  ws: WebSocket
  machine_id: string | null
  authed: boolean
}

interface UiSubscriber {
  ws: WebSocket
}

/**
 * One DO instance per project_id. Holds the kanban brain for the project:
 * card list, per-(project_id, branch) drain queue, session liveness, and
 * the WS to whichever Bun supervisor is currently paired.
 */
export class ProjectDO implements DurableObject {
  private state: DurableObjectState
  private env: Env
  private bun: BunConn | null = null
  private uiSubs = new Set<UiSubscriber>()
  // (project_id, branch) -> live session role
  private liveSessions = new Map<string, 'kanban-work' | 'kanban-ops'>()
  // dedupe inbound reply_tool_call by tool_call_id (replay-safe)
  private seenToolCalls = new Set<string>()

  constructor(state: DurableObjectState, env: Env) {
    this.state = state
    this.env = env
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname

    // ─── WS endpoints ────────────────────────────────────────────────────
    if (path === '/__ws/bun') return this.acceptBunWs(req)
    if (path === '/__ws/ui') return this.acceptUiWs(req)

    // ─── REST endpoints (DO-internal) ────────────────────────────────────
    if (req.method === 'GET' && path === '/cards') {
      return Response.json(await this.listCards())
    }
    if (req.method === 'POST' && path === '/cards') {
      const body = (await req.json()) as Partial<Card> & { project_id: string }
      const card = await this.createCard(body)
      return Response.json(card, { status: 201 })
    }
    if (req.method === 'POST') {
      const m = path.match(/^\/cards\/([^/]+)\/(approve|spawn|input)$/)
      if (m) {
        const [, cardId, action] = m
        if (!cardId) return new Response('bad request', { status: 400 })
        if (action === 'approve') return Response.json(await this.approveCard(cardId))
        if (action === 'spawn') return Response.json(await this.spawnForCard(cardId))
        if (action === 'input') {
          const { answer } = (await req.json()) as { answer: string }
          return Response.json(await this.deliverInput(cardId, answer))
        }
      }
    }

    return new Response('not found', { status: 404 })
  }

  // ─── persistence helpers ───────────────────────────────────────────────
  private async listCards(): Promise<Card[]> {
    const m = (await this.state.storage.list<Card>({ prefix: 'card:' })) as Map<string, Card>
    return [...m.values()].sort((a, b) => a.created_at - b.created_at)
  }

  private async getCard(id: string): Promise<Card | undefined> {
    return await this.state.storage.get<Card>(`card:${id}`)
  }

  private async putCard(card: Card): Promise<void> {
    card.updated_at = Date.now()
    await this.state.storage.put(`card:${card.id}`, card)
    this.notifyUi()
  }

  // ─── card lifecycle ────────────────────────────────────────────────────
  private async createCard(input: Partial<Card> & { project_id: string }): Promise<Card> {
    const id = crypto.randomUUID()
    const now = Date.now()
    const card: Card = {
      id,
      project_id: input.project_id,
      title: input.title ?? 'Untitled',
      description: input.description ?? '',
      target_branch: input.target_branch ?? 'main',
      status: 'backlog',
      created_at: now,
      updated_at: now,
      evidence: [],
      merge_strategy: input.merge_strategy ?? 'squash',
      repo_policy: input.repo_policy ?? 'own',
    }
    await this.putCard(card)
    // v1: do not auto-spawn. User clicks "spawn worker" in UI.
    return card
  }

  private async approveCard(id: string): Promise<Card | { error: string }> {
    const card = await this.getCard(id)
    if (!card) return { error: 'not_found' }
    if (!canTransition(card.status, 'approved')) {
      return { error: `illegal_transition_from_${card.status}` }
    }
    card.status = 'approved'
    await this.putCard(card)
    // queue ops Claude on next tick — spawn via paired Bun
    await this.requestOpsSpawn(card)
    return card
  }

  /** User clicked "spawn worker for branch" — kick the bun supervisor. */
  private async spawnForCard(id: string): Promise<Card | { error: string }> {
    const card = await this.getCard(id)
    if (!card) return { error: 'not_found' }
    if (!this.bun) return { error: 'no_bun_paired' }

    this.send({
      type: 'ensure_worktree',
      project_id: card.project_id,
      branch: card.target_branch,
    })

    const initial: ChannelEvent = {
      content: card.description || card.title,
      meta: {
        project_id: card.project_id,
        branch: card.target_branch,
        card_id: card.id,
        role: 'kanban-work',
        event_kind: 'card',
      },
    }

    this.send({
      type: 'spawn_session',
      project_id: card.project_id,
      project_path: '__bun_resolves__',
      branch: card.target_branch,
      role: 'kanban-work',
      initial_event: initial,
    })

    if (canTransition(card.status, 'assigned')) card.status = 'assigned'
    await this.putCard(card)
    return card
  }

  private async deliverInput(cardId: string, answer: string): Promise<Card | { error: string }> {
    const card = await this.getCard(cardId)
    if (!card) return { error: 'not_found' }
    card.pending_input = null
    await this.putCard(card)
    if (!this.bun) return { error: 'no_bun_paired' }
    this.send({
      type: 'push_event',
      project_id: card.project_id,
      branch: card.target_branch,
      channel_event: {
        content: answer,
        meta: {
          project_id: card.project_id,
          branch: card.target_branch,
          card_id: card.id,
          role: 'kanban-work',
          event_kind: 'input_response',
        },
      },
    })
    return card
  }

  private async requestOpsSpawn(card: Card): Promise<void> {
    if (!this.bun) return
    const initial: ChannelEvent = {
      content: `Finalize ${card.target_branch} for card ${card.id}: ${card.merge_strategy} into project default branch.`,
      meta: {
        project_id: card.project_id,
        branch: card.target_branch,
        card_id: card.id,
        role: 'kanban-ops',
        event_kind: 'card',
      },
    }
    if (canTransition(card.status, 'merging')) {
      card.status = 'merging'
      await this.putCard(card)
    }
    this.send({
      type: 'spawn_session',
      project_id: card.project_id,
      project_path: '__bun_resolves_main__',
      branch: card.target_branch,
      role: 'kanban-ops',
      initial_event: initial,
    })
  }

  // ─── Bun WS plumbing ───────────────────────────────────────────────────
  private async acceptBunWs(req: Request): Promise<Response> {
    if (req.headers.get('upgrade') !== 'websocket') {
      return new Response('expected upgrade', { status: 426 })
    }
    const presented = req.headers.get('authorization')?.replace(/^Bearer /, '') ?? ''
    if (!this.env.BUN_SHARED_TOKEN || presented !== this.env.BUN_SHARED_TOKEN) {
      return new Response('unauthorized', { status: 401 })
    }
    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    server.accept()
    this.bun = { ws: server, machine_id: null, authed: true }

    server.addEventListener('message', (ev) => this.onBunMessage(ev))
    server.addEventListener('close', () => {
      this.bun = null
      this.liveSessions.clear()
      this.notifyUi()
    })
    server.addEventListener('error', () => {
      this.bun = null
      this.liveSessions.clear()
    })

    return new Response(null, { status: 101, webSocket: client })
  }

  private onBunMessage(ev: MessageEvent): void {
    let msg: BunToWorker
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '{}') as BunToWorker
    } catch {
      return
    }
    switch (msg.type) {
      case 'hello':
        if (this.bun) this.bun.machine_id = msg.machine_id
        if (msg.protocol_version !== PROTOCOL_VERSION) {
          // tolerate but log
          console.warn('protocol mismatch from', msg.machine_id)
        }
        break
      case 'heartbeat':
        // refresh liveness on every heartbeat
        this.liveSessions.clear()
        for (const s of msg.sessions_live) {
          this.liveSessions.set(`${s.project_id}::${s.branch}`, s.role)
        }
        break
      case 'session_registered':
        this.liveSessions.set(`${msg.project_id}::${msg.branch}`, msg.role)
        break
      case 'session_terminated':
        this.liveSessions.delete(`${msg.project_id}::${msg.branch}`)
        break
      case 'reply_tool_call':
        if (this.seenToolCalls.has(msg.tool_call_id)) return
        this.seenToolCalls.add(msg.tool_call_id)
        void this.applyReplyToolCall(msg)
        break
      case 'permission_request':
        // v1.5 — store and surface to UI; for now just notify
        this.notifyUi()
        break
    }
  }

  private async applyReplyToolCall(
    msg: Extract<BunToWorker, { type: 'reply_tool_call' }>,
  ): Promise<void> {
    const args = msg.args as { card_id?: string }
    if (!args?.card_id) return
    const card = await this.getCard(args.card_id)
    if (!card) return
    switch (msg.tool_name) {
      case 'update_card': {
        const a = msg.args as {
          card_id: string
          status: 'in_progress' | 'done' | 'blocked'
          evidence?: Card['evidence'][number]
        }
        const next: CardStatus =
          a.status === 'done'
            ? 'done-pending-review'
            : a.status === 'in_progress'
              ? 'in_progress'
              : card.status
        if (canTransition(card.status, next)) card.status = next
        if (a.evidence) card.evidence.push({ ...a.evidence, at: Date.now() })
        await this.putCard(card)
        break
      }
      case 'request_input': {
        const a = msg.args as { card_id: string; prompt: string }
        card.pending_input = { prompt: a.prompt, at: Date.now() }
        await this.putCard(card)
        break
      }
      case 'report_progress': {
        const a = msg.args as { card_id: string; note: string }
        card.evidence.push({ kind: 'note', value: a.note, at: Date.now() })
        await this.putCard(card)
        break
      }
      case 'report_step': {
        const a = msg.args as {
          card_id: string
          step: string
          status: 'running' | 'ok' | 'failed'
          detail?: string
        }
        card.finalize_steps = card.finalize_steps ?? []
        card.finalize_steps.push({
          step: a.step,
          status: a.status,
          detail: a.detail,
          at: Date.now(),
        })
        if (a.step === 'merge' && a.status === 'ok' && canTransition(card.status, 'merged')) {
          card.status = 'merged'
        } else if (a.step === 'merge' && a.status === 'failed') {
          card.status = 'merge_failed'
          card.error = a.detail ?? 'merge failed'
        } else if (
          a.step === 'cleanup' &&
          a.status === 'running' &&
          canTransition(card.status, 'cleaning')
        ) {
          card.status = 'cleaning'
        } else if (
          a.step === 'cleanup' &&
          a.status === 'ok' &&
          canTransition(card.status, 'archived')
        ) {
          card.status = 'archived'
        } else if (a.step === 'cleanup' && a.status === 'failed') {
          card.status = 'clean_failed'
          card.error = a.detail ?? 'cleanup failed'
        }
        await this.putCard(card)
        break
      }
    }
  }

  private send(msg: WorkerToBun): void {
    if (!this.bun) return
    try {
      this.bun.ws.send(JSON.stringify(msg))
    } catch (err) {
      console.error('bun ws send failed', err)
    }
  }

  // ─── UI live-update WS ─────────────────────────────────────────────────
  private async acceptUiWs(req: Request): Promise<Response> {
    if (req.headers.get('upgrade') !== 'websocket') {
      return new Response('expected upgrade', { status: 426 })
    }
    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    server.accept()
    const sub: UiSubscriber = { ws: server }
    this.uiSubs.add(sub)
    server.addEventListener('close', () => this.uiSubs.delete(sub))
    server.addEventListener('error', () => this.uiSubs.delete(sub))
    return new Response(null, { status: 101, webSocket: client })
  }

  private notifyUi(): void {
    const payload = JSON.stringify({ t: Date.now() })
    for (const s of this.uiSubs) {
      try {
        s.ws.send(payload)
      } catch {
        this.uiSubs.delete(s)
      }
    }
  }
}
