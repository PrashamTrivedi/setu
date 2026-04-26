/// <reference types="@cloudflare/workers-types" />
import type { BunToWorker, Card, CardStatus, ChannelEvent, WorkerToBun } from '@kanban/protocol'
import { canTransition } from '@kanban/protocol'
import type { Env } from './types.ts'

/**
 * One DO instance per `project_id` (plus a singleton at name `__registry__`).
 *
 * The DO no longer holds a WS to Bun directly. Instead it tracks which
 * `machine_id` claims this project, then forwards outbound messages to the
 * corresponding MachineDO via DO-to-DO RPC. Inbound messages from Bun arrive
 * at MachineDO and get fanned out to the right ProjectDO via /_inbound.
 *
 * The singleton `__registry__` instance holds the machine→projects index that
 * the UI uses to enumerate known projects without listing DOs.
 */
export class ProjectDO implements DurableObject {
  private state: DurableObjectState
  private env: Env
  // dedupe inbound reply_tool_call by tool_call_id (replay-safe)
  private seenToolCalls = new Set<string>()

  constructor(state: DurableObjectState, env: Env) {
    this.state = state
    this.env = env
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname

    // ─── Registry singleton ──────────────────────────────────────────────
    if (path.startsWith('/_registry/')) return this.handleRegistry(req, path)

    // ─── Internal RPC from MachineDO ─────────────────────────────────────
    if (req.method === 'POST' && path === '/_pair') {
      const { machine_id } = (await req.json()) as { machine_id: string }
      await this.state.storage.put('machine_id', machine_id)
      return Response.json({ ok: true })
    }
    if (req.method === 'POST' && path === '/_unpair') {
      const { machine_id } = (await req.json()) as { machine_id: string }
      const current = await this.state.storage.get<string>('machine_id')
      if (current === machine_id) await this.state.storage.delete('machine_id')
      return Response.json({ ok: true })
    }
    if (req.method === 'POST' && path === '/_inbound') {
      const msg = (await req.json()) as BunToWorker
      await this.onInboundFromMachine(msg)
      return Response.json({ ok: true })
    }

    // ─── Public REST (called via worker proxy) ───────────────────────────
    if (req.method === 'GET' && path === '/cards') {
      return Response.json(await this.listCards())
    }
    if (req.method === 'POST' && path === '/cards') {
      const body = (await req.json()) as Partial<Card> & { project_id: string }
      const card = await this.createCard(body)
      return Response.json(card, { status: 201 })
    }
    if (req.method === 'GET' && path === '/status') {
      const machine_id = (await this.state.storage.get<string>('machine_id')) ?? null
      return Response.json({ paired: !!machine_id, machine_id })
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

  // ─── Registry singleton (only meaningful at name '__registry__') ──────
  private async handleRegistry(req: Request, path: string): Promise<Response> {
    if (req.method === 'POST' && path === '/_registry/upsert') {
      const body = (await req.json()) as { machine_id: string; projects: string[] }
      await this.state.storage.put(`machine:${body.machine_id}`, {
        machine_id: body.machine_id,
        projects: body.projects,
        connected_at: Date.now(),
      })
      return Response.json({ ok: true })
    }
    if (req.method === 'POST' && path === '/_registry/down') {
      const body = (await req.json()) as { machine_id: string }
      await this.state.storage.delete(`machine:${body.machine_id}`)
      return Response.json({ ok: true })
    }
    if (req.method === 'GET' && path === '/_registry/list') {
      const all = (await this.state.storage.list<{
        machine_id: string
        projects: string[]
        connected_at: number
      }>({ prefix: 'machine:' })) as Map<
        string,
        { machine_id: string; projects: string[]; connected_at: number }
      >
      const machines = [...all.values()]
      const projectSet = new Set<string>()
      for (const m of machines) for (const p of m.projects) projectSet.add(p)
      return Response.json({ machines, projects: [...projectSet].sort() })
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
    await this.requestOpsSpawn(card)
    return card
  }

  private async spawnForCard(id: string): Promise<Card | { error: string }> {
    const card = await this.getCard(id)
    if (!card) return { error: 'not_found' }
    const machine_id = await this.state.storage.get<string>('machine_id')
    if (!machine_id) return { error: 'no_machine_paired_for_this_project' }

    await this.sendToMachine(machine_id, {
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

    await this.sendToMachine(machine_id, {
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
    const machine_id = await this.state.storage.get<string>('machine_id')
    if (!machine_id) return { error: 'no_machine_paired_for_this_project' }
    await this.sendToMachine(machine_id, {
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
    const machine_id = await this.state.storage.get<string>('machine_id')
    if (!machine_id) return
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
    await this.sendToMachine(machine_id, {
      type: 'spawn_session',
      project_id: card.project_id,
      project_path: '__bun_resolves_main__',
      branch: card.target_branch,
      role: 'kanban-ops',
      initial_event: initial,
    })
  }

  private async sendToMachine(machine_id: string, msg: WorkerToBun): Promise<void> {
    const id = this.env.MACHINE_DO.idFromName(machine_id)
    const stub = this.env.MACHINE_DO.get(id)
    try {
      await stub.fetch('https://internal/send', {
        method: 'POST',
        body: JSON.stringify(msg),
        headers: { 'content-type': 'application/json' },
      })
    } catch (err) {
      console.error('sendToMachine failed', err)
    }
  }

  // ─── Inbound from MachineDO ────────────────────────────────────────────
  private async onInboundFromMachine(msg: BunToWorker): Promise<void> {
    switch (msg.type) {
      case 'session_registered':
      case 'session_terminated':
        // could track liveness in storage; v1 keeps it stateless
        return
      case 'reply_tool_call': {
        if (this.seenToolCalls.has(msg.tool_call_id)) return
        this.seenToolCalls.add(msg.tool_call_id)
        await this.applyReplyToolCall(msg)
        return
      }
      case 'permission_request':
        // v1.5 surface
        return
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
}
