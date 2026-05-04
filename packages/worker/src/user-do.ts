/// <reference types="@cloudflare/workers-types" />
import type {
  FeedItem,
  MachineSummary,
  ProjectSummary,
  PushSubscriptionJSON,
  UiToWorker,
  WorkerToUi,
} from '@kanban/ui-protocol'
import { UI_PROTOCOL_VERSION } from '@kanban/ui-protocol'
import type { Env } from './types.ts'
import { sendPush } from './web-push.ts'

interface UiClient {
  client_id: string
  ws: WebSocket
  subscribed: Set<string>
}

interface QuietHours {
  /** "HH:MM" 24-hour, in `tz`. */
  from: string
  to: string
  /** IANA tz, e.g. "Asia/Kolkata". */
  tz: string
}

/**
 * Singleton at name `__me__` for v1 single-user. Owns:
 *   - WS to the UI(s)
 *   - machine→projects registry (replaces __registry__ in ProjectDO)
 *   - push subscriptions
 *   - quiet-hours digest queue + drain alarm
 */
export class UserDO implements DurableObject {
  private state: DurableObjectState
  private env: Env
  private clients = new Map<string, UiClient>()

  constructor(state: DurableObjectState, env: Env) {
    this.state = state
    this.env = env
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname

    if (path === '/__ws/ui') return this.acceptUiWs(req)

    // Internal RPCs from MachineDO ───────────────────────────────────────
    if (req.method === 'POST' && path === '/__machine/upsert') {
      const body = (await req.json()) as MachineSummary
      await this.state.storage.put(`machine:${body.machine_id}`, body)
      return Response.json({ ok: true })
    }
    if (req.method === 'POST' && path === '/__machine/down') {
      const { machine_id } = (await req.json()) as { machine_id: string }
      await this.state.storage.delete(`machine:${machine_id}`)
      return Response.json({ ok: true })
    }

    // Internal RPC from ProjectDO ────────────────────────────────────────
    if (req.method === 'POST' && path === '/__broadcast') {
      const body = (await req.json()) as { project_id: string; item: FeedItem }
      await this.handleBroadcast(body.project_id, body.item)
      return Response.json({ ok: true })
    }

    // Public REST ─────────────────────────────────────────────────────────
    if (req.method === 'GET' && path === '/projects') {
      return Response.json(await this.snapshotMachines())
    }

    return new Response('not found', { status: 404 })
  }

  // ─── Alarm: quiet-hours digest drain ───────────────────────────────────
  async alarm(): Promise<void> {
    const queues = (await this.state.storage.list<FeedItem[]>({
      prefix: 'digest_queue:',
    })) as Map<string, FeedItem[]>
    let totalItems = 0
    for (const [key, items] of queues) {
      if (items.length === 0) {
        await this.state.storage.delete(key)
        continue
      }
      const project_id = key.slice('digest_queue:'.length)
      this.fanout({ type: 'digest', project_id, items })
      totalItems += items.length
      await this.state.storage.delete(key)
    }
    await this.state.storage.delete('quiet_alarm')
    if (totalItems > 0) await this.pushAll(`${totalItems} updates`)
  }

  // ─── WS plumbing ───────────────────────────────────────────────────────
  private async acceptUiWs(req: Request): Promise<Response> {
    if (req.headers.get('upgrade') !== 'websocket') {
      return new Response('expected upgrade', { status: 426 })
    }
    const url = new URL(req.url)
    // Browsers can't set Authorization on a WS handshake — accept the bearer
    // via `?access_token=` as well. The UI sends the token here; native
    // clients (wscat) keep using the Authorization header.
    const fromHeader = req.headers.get('authorization')?.replace(/^Bearer /, '') ?? ''
    const fromQuery = url.searchParams.get('access_token') ?? ''
    const presented = fromHeader || fromQuery
    if (!this.env.UI_BEARER || presented !== this.env.UI_BEARER) {
      return new Response('unauthorized', { status: 401 })
    }
    const client_id = url.searchParams.get('client_id') ?? crypto.randomUUID()

    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    server.accept()

    const entry: UiClient = { client_id, ws: server, subscribed: new Set() }
    this.clients.set(client_id, entry)
    server.addEventListener('message', (ev) => this.onUiMessage(entry, ev))
    server.addEventListener('close', () => this.clients.delete(client_id))
    server.addEventListener('error', () => this.clients.delete(client_id))

    const me = {
      client_id,
      machines: await this.listMachines(),
      projects: await this.snapshotProjects(),
    }
    this.send(server, {
      type: 'welcome',
      me,
      ui_protocol_version: UI_PROTOCOL_VERSION,
    })

    return new Response(null, { status: 101, webSocket: client })
  }

  private onUiMessage(entry: UiClient, ev: MessageEvent): void {
    let msg: UiToWorker
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '{}') as UiToWorker
    } catch {
      return
    }
    void this.handleUiMessage(entry, msg)
  }

  private async handleUiMessage(entry: UiClient, msg: UiToWorker): Promise<void> {
    switch (msg.type) {
      case 'hello':
        // welcome already sent on accept; nothing to do.
        return
      case 'subscribe':
        for (const p of msg.project_ids) entry.subscribed.add(p)
        await this.state.storage.put(`subs:${entry.client_id}`, [...entry.subscribed])
        return
      case 'unsubscribe':
        for (const p of msg.project_ids) entry.subscribed.delete(p)
        await this.state.storage.put(`subs:${entry.client_id}`, [...entry.subscribed])
        return
      case 'replay': {
        const items = await this.fetchReplay(msg.project_id, msg.since ?? 0)
        this.send(entry.ws, { type: 'feed_replay', project_id: msg.project_id, items })
        return
      }
      case 'permission_verdict':
        await this.relayPermissionVerdict(msg)
        return
      case 'redirect': {
        // Forward to ProjectDO's existing card-input REST. ProjectDO clears
        // pending_input on the card and emits an input_response push to the
        // paired Bun supervisor, which the channel-server feeds to Claude.
        await this.callProject(
          msg.project_id,
          `/cards/${msg.card_id}/input`,
          'POST',
          JSON.stringify({ answer: msg.body }),
        ).catch((err) => console.error('redirect forward failed', err))
        return
      }
      case 'spawn_card':
        await this.callProject(msg.project_id, `/cards/${msg.card_id}/spawn`, 'POST')
        return
      case 'register_push':
        await this.state.storage.put(`push:${entry.client_id}`, msg.subscription)
        return
      case 'unregister_push':
        await this.state.storage.delete(`push:${entry.client_id}`)
        return
      case 'set_quiet_hours': {
        const qh: QuietHours = { from: msg.from, to: msg.to, tz: msg.tz }
        await this.state.storage.put('quiet_hours', qh)
        return
      }
      case 'clear_quiet_hours':
        await this.state.storage.delete('quiet_hours')
        return
      case 'pong':
        return
    }
  }

  private send(ws: WebSocket, msg: WorkerToUi): void {
    try {
      ws.send(JSON.stringify(msg))
    } catch {}
  }

  private fanout(msg: WorkerToUi): void {
    for (const c of this.clients.values()) {
      if (msg.type === 'feed_item' && !c.subscribed.has(msg.project_id)) continue
      if (msg.type === 'digest' && !c.subscribed.has(msg.project_id)) continue
      this.send(c.ws, msg)
    }
  }

  // ─── Broadcast pipeline ────────────────────────────────────────────────
  private async handleBroadcast(project_id: string, item: FeedItem): Promise<void> {
    this.fanout({ type: 'feed_item', project_id, item })
    await this.notify(project_id, item)
  }

  private async notify(project_id: string, item: FeedItem): Promise<void> {
    const urgent = isUrgent(item)
    const qh = (await this.state.storage.get<QuietHours>('quiet_hours')) ?? null
    const inQuiet = qh ? isInQuiet(qh, new Date()) : false

    if (urgent || !inQuiet || !qh) {
      await this.pushAll(summary(item))
      return
    }
    // Quiet path: queue and arm an alarm at quiet-end.
    const queueKey = `digest_queue:${project_id}`
    const existing = (await this.state.storage.get<FeedItem[]>(queueKey)) ?? []
    existing.push(item)
    await this.state.storage.put(queueKey, existing)
    await this.armQuietAlarm(qh)
  }

  private async armQuietAlarm(qh: QuietHours): Promise<void> {
    const have = await this.state.storage.get<number>('quiet_alarm')
    if (have) return
    const at = quietEndEpoch(qh, new Date())
    await this.state.storage.put('quiet_alarm', at)
    await this.state.storage.setAlarm(at)
  }

  private async pushAll(_text: string): Promise<void> {
    if (!this.env.VAPID_PRIVATE_KEY || !this.env.VAPID_PUBLIC_KEY || !this.env.VAPID_SUBJECT) {
      return
    }
    const subs = (await this.state.storage.list<PushSubscriptionJSON>({
      prefix: 'push:',
    })) as Map<string, PushSubscriptionJSON>
    if (subs.size === 0) return
    const vapid = {
      privateKey: this.env.VAPID_PRIVATE_KEY,
      publicKey: this.env.VAPID_PUBLIC_KEY,
      subject: this.env.VAPID_SUBJECT,
    }
    await Promise.all(
      [...subs.values()].map((s) =>
        sendPush(s, vapid).catch((err) => console.error('sendPush failed', err)),
      ),
    )
  }

  private async relayPermissionVerdict(msg: {
    request_id: string
    behavior: 'allow' | 'deny'
    scope: 'once' | 'branch' | 'forever'
  }): Promise<void> {
    // We don't know which project the request belongs to; broadcast to all
    // subscribed projects' DOs. v1 is single-user, project counts are small,
    // and ProjectDO no-ops on unknown request_ids.
    const machines = await this.listMachines()
    const projects = new Set<string>()
    for (const m of machines) for (const p of m.projects) projects.add(p)
    await Promise.all(
      [...projects].map((p) =>
        this.callProject(p, '/_ui_verdict', 'POST', JSON.stringify(msg)).catch(() => null),
      ),
    )
  }

  private async callProject(
    project_id: string,
    path: string,
    method: 'GET' | 'POST',
    body?: string,
  ): Promise<Response> {
    const stub = this.env.PROJECT_DO.get(this.env.PROJECT_DO.idFromName(project_id))
    return stub.fetch(`https://internal${path}`, {
      method,
      ...(body ? { body, headers: { 'content-type': 'application/json' } } : {}),
    })
  }

  private async fetchReplay(project_id: string, since: number): Promise<FeedItem[]> {
    const res = await this.callProject(project_id, `/_feed_replay?since=${since}`, 'GET').catch(
      () => null,
    )
    if (!res || !res.ok) return []
    const body = (await res.json()) as { items: FeedItem[] }
    return body.items
  }

  private async listMachines(): Promise<MachineSummary[]> {
    const m = (await this.state.storage.list<MachineSummary>({ prefix: 'machine:' })) as Map<
      string,
      MachineSummary
    >
    return [...m.values()]
  }

  private async snapshotMachines(): Promise<{
    machines: MachineSummary[]
    projects: string[]
  }> {
    const machines = await this.listMachines()
    const projects = new Set<string>()
    for (const m of machines) for (const p of m.projects) projects.add(p)
    return { machines, projects: [...projects].sort() }
  }

  private async snapshotProjects(): Promise<ProjectSummary[]> {
    const machines = await this.listMachines()
    const projects = new Set<string>()
    for (const m of machines) for (const p of m.projects) projects.add(p)
    return [...projects].map((project_id) => ({ project_id }))
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isUrgent(item: FeedItem): boolean {
  if (item.kind === 'perm_ask') return true
  if (
    item.kind === 'dispatch' &&
    (item.dispatch_kind === 'asking' || item.dispatch_kind === 'committing')
  ) {
    return true
  }
  return false
}

function summary(item: FeedItem): string {
  switch (item.kind) {
    case 'dispatch':
      return `${item.from_role} ${item.dispatch_kind}: ${item.body.slice(0, 80)}`
    case 'perm_ask':
      return `permission: ${item.tool_name}`
    case 'card_state':
      return `card ${item.from} → ${item.to}`
    case 'peer_in':
      return `${item.from_role}: ${item.body.slice(0, 80)}`
  }
}

function isInQuiet(qh: QuietHours, now: Date): boolean {
  const local = toTzMinutes(qh.tz, now)
  const from = parseHm(qh.from)
  const to = parseHm(qh.to)
  if (from === to) return false
  return from < to ? local >= from && local < to : local >= from || local < to
}

function quietEndEpoch(qh: QuietHours, now: Date): number {
  const local = toTzMinutes(qh.tz, now)
  const to = parseHm(qh.to)
  let diff = (to - local + 24 * 60) % (24 * 60)
  if (diff === 0) diff = 24 * 60
  return now.getTime() + diff * 60_000
}

function parseHm(hm: string): number {
  const [h, m] = hm.split(':').map((s) => Number.parseInt(s, 10))
  return (h ?? 0) * 60 + (m ?? 0)
}

function toTzMinutes(tz: string, d: Date): number {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  })
  const parts = fmt.formatToParts(d)
  const h = Number.parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10)
  const m = Number.parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10)
  return h * 60 + m
}
