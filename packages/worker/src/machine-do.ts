/// <reference types="@cloudflare/workers-types" />
import type { BunToWorker, SessionLiveSummary, WorkerToBun } from '@kanban/protocol'
import { PROTOCOL_VERSION } from '@kanban/protocol'
import type { Env } from './types.ts'

interface BunSession {
  ws: WebSocket
  machine_id: string
  projects: string[]
  last_heartbeat: number
}

/**
 * One DO instance per `machine_id`. Holds the WS to the matching Bun
 * supervisor and routes messages between Bun and the relevant ProjectDOs.
 *
 * Bun connects to /ws/bun/<machine_id> with a bearer token. After the hello
 * handshake, this DO knows which project_ids the machine claims and:
 *   - inbound  Bun → ProjectDO  via env.PROJECT_DO.idFromName(project_id)
 *   - outbound ProjectDO → Bun  via this DO's /send endpoint (DO-to-DO RPC)
 *
 * Phase 1.5: the latest `sessions_live` snapshot from heartbeats is persisted
 * so ProjectDO can resolve `to_role` peer routing without keeping a live RPC
 * channel back to the supervisor.
 *
 * Phase 2: machine→projects registration moves to UserDO. The legacy
 * `__registry__` ProjectDO singleton is retired.
 */
export class MachineDO implements DurableObject {
  private state: DurableObjectState
  private env: Env
  private session: BunSession | null = null

  constructor(state: DurableObjectState, env: Env) {
    this.state = state
    this.env = env
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname

    if (path === '/__ws/bun') return this.acceptBunWs(req)

    if (req.method === 'POST' && path === '/__set_machine_id') {
      const { machine_id } = (await req.json()) as { machine_id: string }
      await this.setMachineId(machine_id)
      return Response.json({ ok: true })
    }

    // DO-to-DO RPC from ProjectDO when it wants to send a message to Bun.
    if (req.method === 'POST' && path === '/send') {
      const msg = (await req.json()) as WorkerToBun
      const ok = this.sendToBun(msg)
      return Response.json({ ok })
    }

    if (req.method === 'GET' && path === '/sessions_live') {
      const sessions = (await this.state.storage.get<SessionLiveSummary[]>('sessions_live')) ?? []
      const last_heartbeat_ts = (await this.state.storage.get<number>('last_heartbeat_ts')) ?? null
      return Response.json({ sessions, last_heartbeat_ts })
    }

    if (req.method === 'GET' && path === '/status') {
      return Response.json({
        connected: !!this.session,
        machine_id: this.session?.machine_id ?? null,
        projects: this.session?.projects ?? [],
        last_heartbeat: this.session?.last_heartbeat ?? null,
      })
    }

    return new Response('not found', { status: 404 })
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
    const machineIdFromState = (await this.state.storage.get<string>('machine_id')) ?? 'unknown'
    this.session = {
      ws: server,
      machine_id: machineIdFromState,
      projects: [],
      last_heartbeat: Date.now(),
    }

    server.addEventListener('message', (ev) => this.onBunMessage(ev))
    server.addEventListener('close', () => this.onDisconnect())
    server.addEventListener('error', () => this.onDisconnect())

    return new Response(null, { status: 101, webSocket: client })
  }

  /** Called from the worker entry once it knows the machine_id from the URL. */
  async setMachineId(machine_id: string): Promise<void> {
    await this.state.storage.put('machine_id', machine_id)
    if (this.session) this.session.machine_id = machine_id
  }

  private onDisconnect(): void {
    if (!this.session) return
    void this.unregisterFromUser(this.session.machine_id)
    this.session = null
  }

  private onBunMessage(ev: MessageEvent): void {
    let msg: BunToWorker
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '{}') as BunToWorker
    } catch {
      return
    }

    switch (msg.type) {
      case 'hello': {
        if (!this.session) return
        this.session.machine_id = msg.machine_id
        this.session.projects = msg.projects_available
        if (msg.protocol_version !== PROTOCOL_VERSION) {
          console.warn('protocol mismatch from', msg.machine_id)
        }
        void this.registerWithProjectsAndUser(msg.projects_available, msg.machine_id)
        return
      }
      case 'heartbeat': {
        if (this.session) this.session.last_heartbeat = msg.timestamp
        void this.persistHeartbeat(msg.timestamp, msg.sessions_live)
        return
      }
      case 'session_registered':
      case 'session_terminated':
      case 'reply_tool_call':
      case 'permission_request': {
        const project_id = msg.project_id
        void this.forwardToProject(project_id, msg)
        return
      }
    }
  }

  private async persistHeartbeat(ts: number, sessions_live: SessionLiveSummary[]): Promise<void> {
    await this.state.storage.put('last_heartbeat_ts', ts)
    await this.state.storage.put('sessions_live', sessions_live)
  }

  private async forwardToProject(
    project_id: string,
    msg: Extract<
      BunToWorker,
      {
        type: 'session_registered' | 'session_terminated' | 'reply_tool_call' | 'permission_request'
      }
    >,
  ): Promise<void> {
    const id = this.env.PROJECT_DO.idFromName(project_id)
    const stub = this.env.PROJECT_DO.get(id)
    try {
      await stub.fetch('https://internal/_inbound', {
        method: 'POST',
        body: JSON.stringify(msg),
        headers: { 'content-type': 'application/json' },
      })
    } catch (err) {
      console.error('forwardToProject failed', err)
    }
  }

  private async registerWithProjectsAndUser(projects: string[], machine_id: string): Promise<void> {
    // Pair each ProjectDO with this machine; UserDO holds the registry index.
    await Promise.all([
      ...projects.map((p) =>
        this.env.PROJECT_DO.get(this.env.PROJECT_DO.idFromName(p)).fetch('https://internal/_pair', {
          method: 'POST',
          body: JSON.stringify({ machine_id }),
          headers: { 'content-type': 'application/json' },
        }),
      ),
      this.userStub().fetch('https://internal/__machine/upsert', {
        method: 'POST',
        body: JSON.stringify({ machine_id, projects, connected_at: Date.now() }),
        headers: { 'content-type': 'application/json' },
      }),
    ]).catch((err) => console.error('registerWithProjectsAndUser failed', err))
  }

  private async unregisterFromUser(machine_id: string): Promise<void> {
    await this.userStub()
      .fetch('https://internal/__machine/down', {
        method: 'POST',
        body: JSON.stringify({ machine_id }),
        headers: { 'content-type': 'application/json' },
      })
      .catch(() => {})
    if (this.session) {
      await Promise.all(
        this.session.projects.map((p) =>
          this.env.PROJECT_DO.get(this.env.PROJECT_DO.idFromName(p))
            .fetch('https://internal/_unpair', {
              method: 'POST',
              body: JSON.stringify({ machine_id }),
              headers: { 'content-type': 'application/json' },
            })
            .catch(() => {}),
        ),
      )
    }
  }

  private userStub() {
    return this.env.USER_DO.get(this.env.USER_DO.idFromName('__me__'))
  }

  private sendToBun(msg: WorkerToBun): boolean {
    if (!this.session) return false
    try {
      this.session.ws.send(JSON.stringify(msg))
      return true
    } catch (err) {
      console.error('sendToBun failed', err)
      return false
    }
  }
}
