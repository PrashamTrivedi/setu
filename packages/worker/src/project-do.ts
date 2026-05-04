/// <reference types="@cloudflare/workers-types" />
import type {
  BunToWorker,
  Card,
  CardStatus,
  ChannelEvent,
  DispatchKind,
  SessionRole,
  WorkerToBun,
} from '@kanban/protocol'
import { canTransition } from '@kanban/protocol'
import { type AllowlistRow, branchKey, fingerprint, foreverKey } from './permission-allowlist.ts'
import type { CommittingAlarmRecord, Env, FeedItem, PendingPermission } from './types.ts'

const FEED_CAP_PER_CARD = 200
const FEED_INDEX_CAP = 1000

/**
 * One DO instance per `project_id`.
 *
 * Phase 1 adds the authored-dispatch feed and committing-dispatch alarms.
 * Phase 1.5 lets it look up live peer sessions via MachineDO snapshot.
 * Phase 2 broadcasts FeedItems to UserDO for UI fan-out.
 * Phase 3 adds a permission allowlist with auto-allow on fingerprint hits.
 *
 * The legacy `__registry__` ProjectDO singleton is retired — its job moved
 * to UserDO.
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

    // ─── Internal RPC from UserDO (Phase 2/3) ────────────────────────────
    if (req.method === 'POST' && path === '/_ui_verdict') {
      const body = (await req.json()) as {
        request_id: string
        behavior: 'allow' | 'deny'
        scope: 'once' | 'branch' | 'forever'
      }
      await this.applyUiPermissionVerdict(body)
      return Response.json({ ok: true })
    }
    if (req.method === 'GET' && path === '/_feed_replay') {
      const since = Number(url.searchParams.get('since') ?? '0')
      const items = await this.feedReplay(since)
      return Response.json({ items })
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

  // ─── Alarm: committing-dispatch deadlines ──────────────────────────────
  async alarm(): Promise<void> {
    const now = Date.now()
    const all = (await this.state.storage.list<CommittingAlarmRecord>({
      prefix: 'alarm:',
    })) as Map<string, CommittingAlarmRecord>

    let nextDeadline = Number.POSITIVE_INFINITY
    for (const [key, rec] of all) {
      if (rec.deadline <= now) {
        await this.fireCommitting(rec)
        await this.state.storage.delete(key)
      } else if (rec.deadline < nextDeadline) {
        nextDeadline = rec.deadline
      }
    }

    if (nextDeadline !== Number.POSITIVE_INFINITY) {
      await this.state.storage.setAlarm(nextDeadline)
      await this.state.storage.put('alarm_next', nextDeadline)
    } else {
      await this.state.storage.delete('alarm_next')
    }
  }

  private async fireCommitting(rec: CommittingAlarmRecord): Promise<void> {
    const feedKey = `feed:${rec.card_id}:${rec.feed_seq}`
    const item = await this.state.storage.get<FeedItem>(feedKey)
    if (item && item.kind === 'dispatch' && item.committing) {
      item.committing = { ...item.committing, resolved: true }
      await this.state.storage.put(feedKey, item)
      await this.broadcastFeed(item)
    }
    if (rec.paired_request_tool_call_id) {
      const card = await this.getCard(rec.card_id)
      if (card?.pending_input) {
        card.pending_input = null
        await this.putCard(card)
      }
      const machine_id = await this.state.storage.get<string>('machine_id')
      if (machine_id) {
        await this.sendToMachine(machine_id, {
          type: 'push_event',
          project_id: rec.project_id,
          branch: rec.branch,
          channel_event: {
            content: '__committing_window_expired__',
            meta: {
              project_id: rec.project_id,
              branch: rec.branch,
              card_id: rec.card_id,
              role: 'kanban-work',
              event_kind: 'input_response',
            },
          },
        })
      }
    }
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
    const from = card.status
    card.status = 'approved'
    await this.putCard(card)
    await this.appendCardStateFeed(card.project_id, card.id, from, 'approved')
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

    if (canTransition(card.status, 'assigned')) {
      const from = card.status
      card.status = 'assigned'
      await this.putCard(card)
      await this.appendCardStateFeed(card.project_id, card.id, from, 'assigned')
    }
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
      const from = card.status
      card.status = 'merging'
      await this.putCard(card)
      await this.appendCardStateFeed(card.project_id, card.id, from, 'merging')
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
        await this.applyPermissionRequest(msg)
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
        const from = card.status
        if (canTransition(card.status, next)) card.status = next
        if (a.evidence) card.evidence.push({ ...a.evidence, at: Date.now() })
        await this.putCard(card)
        if (from !== card.status) {
          await this.appendCardStateFeed(card.project_id, card.id, from, card.status)
        }
        break
      }
      case 'request_input': {
        const a = msg.args as { card_id: string; prompt: string }
        card.pending_input = { prompt: a.prompt, at: Date.now() }
        await this.putCard(card)
        // If a committing dispatch is awaiting on this card, pair it so that
        // when the alarm fires we can auto-emit input_response.
        await this.pairPendingCommittingTo(card.id, msg.tool_call_id)
        await this.emitSyntheticDispatch(card, msg.role ?? 'kanban-work', 'asking', a.prompt)
        break
      }
      case 'report_progress': {
        const a = msg.args as { card_id: string; note: string }
        card.evidence.push({ kind: 'note', value: a.note, at: Date.now() })
        await this.putCard(card)
        await this.emitSyntheticDispatch(card, msg.role ?? 'kanban-work', 'noting', a.note)
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
        const from = card.status
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
        if (from !== card.status) {
          await this.appendCardStateFeed(card.project_id, card.id, from, card.status)
        }
        const stepBody = `${a.step}: ${a.status}${a.detail ? ` — ${a.detail}` : ''}`
        await this.emitSyntheticDispatch(card, msg.role ?? 'kanban-ops', 'noting', stepBody)
        break
      }
      case 'dispatch': {
        const a = msg.args as {
          card_id: string
          body: string
          kind: DispatchKind
          to_role?: SessionRole
          default_after_ms?: number
        }
        await this.handleDispatch(msg, a, card)
        break
      }
    }
  }

  // ─── Phase 1 — dispatch handler ────────────────────────────────────────
  private async handleDispatch(
    msg: Extract<BunToWorker, { type: 'reply_tool_call' }>,
    a: {
      card_id: string
      body: string
      kind: DispatchKind
      to_role?: SessionRole
      default_after_ms?: number
    },
    card: Card,
  ): Promise<void> {
    const seq = await this.nextSeq()
    const dispatch_id = crypto.randomUUID()
    const now = Date.now()
    const from_role: SessionRole = msg.role ?? 'kanban-work'

    const item: FeedItem = {
      id: dispatch_id,
      seq,
      ts: now,
      kind: 'dispatch',
      project_id: card.project_id,
      card_id: card.id,
      from_role,
      dispatch_kind: a.kind,
      body: a.body,
      ...(a.to_role ? { to_role: a.to_role } : {}),
      ...(a.kind === 'committing' && a.default_after_ms
        ? {
            committing: {
              default_after_ms: a.default_after_ms,
              deadline: now + a.default_after_ms,
            },
          }
        : {}),
    }

    await this.state.storage.put(`feed:${card.id}:${seq}`, item)
    await this.state.storage.put(`feed_index:${seq}`, {
      card_id: card.id,
      ts: now,
      kind: 'dispatch',
    })
    await this.evictFeedIfNeeded(card.id)
    await this.evictFeedIndexIfNeeded()

    if (item.kind === 'dispatch' && item.committing) {
      const rec: CommittingAlarmRecord = {
        dispatch_id,
        card_id: card.id,
        project_id: card.project_id,
        feed_seq: seq,
        deadline: item.committing.deadline,
        tool_call_id: msg.tool_call_id,
        branch: msg.branch,
      }
      await this.state.storage.put(`alarm:${dispatch_id}`, rec)
      await this.maybeSetAlarm(item.committing.deadline)
    }

    await this.broadcastFeed(item)

    if (a.to_role) {
      await this.routePeerMessage({
        from_role,
        to_role: a.to_role,
        dispatch_kind: a.kind,
        body: a.body,
        project_id: card.project_id,
        branch: msg.branch,
        card_id: card.id,
      }).catch((err) => console.error('peer route failed', err))
    }
  }

  /**
   * Emit a feed item synthesized from a non-`dispatch` reply tool. Lets the
   * UI reflect Claude's activity (request_input, report_progress,
   * report_step) in real time without waiting for the 4s REST poll.
   */
  private async emitSyntheticDispatch(
    card: Card,
    fromRole: SessionRole,
    kind: DispatchKind,
    body: string,
  ): Promise<void> {
    const seq = await this.nextSeq()
    const ts = Date.now()
    const item: FeedItem = {
      id: crypto.randomUUID(),
      seq,
      ts,
      kind: 'dispatch',
      project_id: card.project_id,
      card_id: card.id,
      from_role: fromRole,
      dispatch_kind: kind,
      body,
    }
    await this.state.storage.put(`feed:${card.id}:${seq}`, item)
    await this.state.storage.put(`feed_index:${seq}`, {
      card_id: card.id,
      ts,
      kind: 'dispatch',
    })
    await this.evictFeedIfNeeded(card.id)
    await this.evictFeedIndexIfNeeded()
    await this.broadcastFeed(item)
  }

  private async pairPendingCommittingTo(cardId: string, requestToolCallId: string): Promise<void> {
    const all = (await this.state.storage.list<CommittingAlarmRecord>({
      prefix: 'alarm:',
    })) as Map<string, CommittingAlarmRecord>
    for (const [key, rec] of all) {
      if (rec.card_id === cardId && !rec.paired_request_tool_call_id) {
        rec.paired_request_tool_call_id = requestToolCallId
        await this.state.storage.put(key, rec)
        return
      }
    }
  }

  private async maybeSetAlarm(deadline: number): Promise<void> {
    const next = (await this.state.storage.get<number>('alarm_next')) ?? Number.POSITIVE_INFINITY
    if (deadline < next) {
      await this.state.storage.setAlarm(deadline)
      await this.state.storage.put('alarm_next', deadline)
    }
  }

  private async nextSeq(): Promise<number> {
    const cur = (await this.state.storage.get<number>('feed_seq')) ?? 0
    const next = cur + 1
    await this.state.storage.put('feed_seq', next)
    return next
  }

  private async evictFeedIfNeeded(card_id: string): Promise<void> {
    const m = (await this.state.storage.list<FeedItem>({
      prefix: `feed:${card_id}:`,
    })) as Map<string, FeedItem>
    if (m.size <= FEED_CAP_PER_CARD) return
    const keys = [...m.keys()].sort()
    const toDrop = keys.slice(0, m.size - FEED_CAP_PER_CARD)
    for (const k of toDrop) await this.state.storage.delete(k)
  }

  private async evictFeedIndexIfNeeded(): Promise<void> {
    const m = (await this.state.storage.list({ prefix: 'feed_index:' })) as Map<string, unknown>
    if (m.size <= FEED_INDEX_CAP) return
    const keys = [...m.keys()].sort()
    const toDrop = keys.slice(0, m.size - FEED_INDEX_CAP)
    for (const k of toDrop) await this.state.storage.delete(k)
  }

  private async appendCardStateFeed(
    project_id: string,
    card_id: string,
    from: CardStatus,
    to: CardStatus,
  ): Promise<void> {
    const seq = await this.nextSeq()
    const ts = Date.now()
    const item: FeedItem = {
      id: crypto.randomUUID(),
      seq,
      ts,
      kind: 'card_state',
      project_id,
      card_id,
      from,
      to,
    }
    await this.state.storage.put(`feed:${card_id}:${seq}`, item)
    await this.state.storage.put(`feed_index:${seq}`, { card_id, ts, kind: 'card_state' })
    await this.evictFeedIfNeeded(card_id)
    await this.evictFeedIndexIfNeeded()
    await this.broadcastFeed(item)
  }

  // ─── Phase 1.5 — peer routing via MachineDO snapshot ───────────────────
  private async routePeerMessage(opts: {
    from_role: SessionRole
    to_role: SessionRole
    dispatch_kind: DispatchKind
    body: string
    project_id: string
    branch: string
    card_id: string
  }): Promise<void> {
    const machine_id = await this.findPeerMachine(opts.project_id, opts.branch, opts.to_role)
    if (!machine_id) return
    await this.sendToMachine(machine_id, {
      type: 'push_event',
      project_id: opts.project_id,
      branch: opts.branch,
      channel_event: {
        content: opts.body,
        meta: {
          project_id: opts.project_id,
          branch: opts.branch,
          card_id: opts.card_id,
          role: opts.to_role,
          event_kind: 'peer_message',
          from_role: opts.from_role,
          dispatch_kind: opts.dispatch_kind,
        },
      },
    })
  }

  private async findPeerMachine(
    project_id: string,
    branch: string,
    role: SessionRole,
  ): Promise<string | null> {
    const machine_id = await this.state.storage.get<string>('machine_id')
    if (!machine_id) return null
    const stub = this.env.MACHINE_DO.get(this.env.MACHINE_DO.idFromName(machine_id))
    try {
      const res = await stub.fetch('https://internal/sessions_live')
      if (!res.ok) return null
      const body = (await res.json()) as {
        sessions: Array<{ project_id: string; branch: string; role: SessionRole }>
      }
      const hit = body.sessions.find(
        (s) => s.project_id === project_id && s.branch === branch && s.role === role,
      )
      return hit ? machine_id : null
    } catch {
      return null
    }
  }

  // ─── Phase 2 — broadcast to UserDO ─────────────────────────────────────
  private async broadcastFeed(item: FeedItem): Promise<void> {
    if (!this.env.USER_DO) return
    const stub = this.env.USER_DO.get(this.env.USER_DO.idFromName('__me__'))
    try {
      await stub.fetch('https://internal/__broadcast', {
        method: 'POST',
        body: JSON.stringify({ project_id: item.project_id, item }),
        headers: { 'content-type': 'application/json' },
      })
    } catch (err) {
      console.error('broadcastFeed failed', err)
    }
  }

  private async feedReplay(sinceSeq: number): Promise<FeedItem[]> {
    const m = (await this.state.storage.list<FeedItem>({ prefix: 'feed:' })) as Map<
      string,
      FeedItem
    >
    return [...m.values()].filter((i) => i.seq > sinceSeq).sort((a, b) => a.seq - b.seq)
  }

  // ─── Phase 3 — permission allowlist ────────────────────────────────────
  private async applyPermissionRequest(
    msg: Extract<BunToWorker, { type: 'permission_request' }>,
  ): Promise<void> {
    const fp = await fingerprint(msg.tool_name, msg.input_preview)

    // forever scope hits short-circuit regardless of branch.
    const forever = await this.state.storage.get<AllowlistRow>(foreverKey(fp))
    if (forever) {
      await this.respondToPermission(msg.request_id, 'allow')
      return
    }
    // branch scope is keyed including branch in storage key.
    const onBranch = await this.state.storage.get<AllowlistRow>(branchKey(fp, msg.branch))
    if (onBranch) {
      await this.respondToPermission(msg.request_id, 'allow')
      return
    }

    // Miss — record pending and surface to UI.
    const seq = await this.nextSeq()
    const ts = Date.now()
    const pending: PendingPermission = {
      request_id: msg.request_id,
      project_id: msg.project_id,
      branch: msg.branch,
      tool_name: msg.tool_name,
      description: msg.description,
      input_preview: msg.input_preview,
      fingerprint: fp,
      asked_at: ts,
      feed_seq: seq,
    }
    await this.state.storage.put(`pending_perms:${msg.request_id}`, pending)

    const item: FeedItem = {
      id: crypto.randomUUID(),
      seq,
      ts,
      kind: 'perm_ask',
      project_id: msg.project_id,
      request_id: msg.request_id,
      tool_name: msg.tool_name,
      description: msg.description,
      input_preview: msg.input_preview,
    }
    // perm_ask isn't tied to a specific card — bucket under request_id so
    // eviction logic (per-card prefix) doesn't swallow it.
    await this.state.storage.put(`feed:_perm_${msg.request_id}:${seq}`, item)
    await this.state.storage.put(`feed_index:${seq}`, {
      card_id: null,
      ts,
      kind: 'perm_ask',
    })
    await this.evictFeedIndexIfNeeded()
    await this.broadcastFeed(item)
  }

  private async applyUiPermissionVerdict(body: {
    request_id: string
    behavior: 'allow' | 'deny'
    scope: 'once' | 'branch' | 'forever'
  }): Promise<void> {
    const pending = await this.state.storage.get<PendingPermission>(
      `pending_perms:${body.request_id}`,
    )
    if (!pending) return

    if (body.behavior === 'allow' && body.scope !== 'once') {
      const row: AllowlistRow = { tool_name: pending.tool_name, granted_at: Date.now() }
      if (body.scope === 'forever') {
        await this.state.storage.put(foreverKey(pending.fingerprint), row)
      } else {
        await this.state.storage.put(branchKey(pending.fingerprint, pending.branch), row)
      }
    }

    await this.respondToPermission(pending.request_id, body.behavior)
    await this.state.storage.delete(`pending_perms:${body.request_id}`)

    // Mark the existing perm_ask feed item as resolved + rebroadcast.
    const feedKey = `feed:_perm_${pending.request_id}:${pending.feed_seq}`
    const item = await this.state.storage.get<FeedItem>(feedKey)
    if (item && item.kind === 'perm_ask') {
      item.resolved = { behavior: body.behavior, scope: body.scope, at: Date.now() }
      await this.state.storage.put(feedKey, item)
      await this.broadcastFeed(item)
    }
  }

  private async respondToPermission(request_id: string, behavior: 'allow' | 'deny'): Promise<void> {
    const machine_id = await this.state.storage.get<string>('machine_id')
    if (!machine_id) return
    await this.sendToMachine(machine_id, {
      type: 'permission_verdict',
      request_id,
      behavior,
    })
  }
}
