import type { BunToWorker, WorkerToBun } from '@kanban/protocol'
import { PROTOCOL_VERSION } from '@kanban/protocol'
import type { BunConfig } from './config.ts'

type OnInbound = (msg: WorkerToBun) => void

const RECONNECT_INITIAL_MS = 1_000
const RECONNECT_MAX_MS = 30_000
const HEARTBEAT_MS = 15_000

export class WorkerLink {
  private cfg: BunConfig
  private onInbound: OnInbound
  private ws: WebSocket | null = null
  private outbox: BunToWorker[] = []
  private reconnectMs = RECONNECT_INITIAL_MS
  private hbTimer: ReturnType<typeof setInterval> | null = null
  private stopped = false

  // Live sessions reported on heartbeat — populated by the supervisor.
  liveSessions: () => BunToWorker extends { type: 'heartbeat' } ? never : never = () =>
    undefined as never
  private getLiveSessions: () => Array<{
    project_id: string
    branch: string
    role: 'kanban-work' | 'kanban-ops'
  }> = () => []

  constructor(cfg: BunConfig, onInbound: OnInbound) {
    this.cfg = cfg
    this.onInbound = onInbound
  }

  setLiveSessionsProvider(
    fn: () => Array<{ project_id: string; branch: string; role: 'kanban-work' | 'kanban-ops' }>,
  ): void {
    this.getLiveSessions = fn
  }

  start(): void {
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.hbTimer) clearInterval(this.hbTimer)
    this.hbTimer = null
    try {
      this.ws?.close()
    } catch {}
    this.ws = null
  }

  send(msg: BunToWorker): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(msg))
        return
      } catch {}
    }
    // buffer; replayed on reconnect (idempotent thanks to tool_call_id dedup)
    this.outbox.push(msg)
  }

  private connect(): void {
    if (this.stopped) return
    const ws = new WebSocket(this.cfg.workerWs, {
      // bun supports `headers` on WebSocket constructor
      headers: { authorization: `Bearer ${this.cfg.bearerToken}` },
    } as unknown as undefined)
    this.ws = ws

    ws.addEventListener('open', () => {
      this.reconnectMs = RECONNECT_INITIAL_MS
      // hello
      this.flushOutbox()
      this.send({
        type: 'hello',
        machine_id: this.cfg.machineId,
        projects_available: [...this.cfg.projects.keys()],
        protocol_version: PROTOCOL_VERSION,
      })
      this.flushOutbox()
      if (this.hbTimer) clearInterval(this.hbTimer)
      this.hbTimer = setInterval(() => {
        this.send({
          type: 'heartbeat',
          timestamp: Date.now(),
          sessions_live: this.getLiveSessions(),
        })
      }, HEARTBEAT_MS)
    })

    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '{}') as WorkerToBun
        this.onInbound(msg)
      } catch {}
    })

    const onDown = () => {
      if (this.hbTimer) clearInterval(this.hbTimer)
      this.hbTimer = null
      this.ws = null
      if (this.stopped) return
      const wait = this.reconnectMs
      this.reconnectMs = Math.min(this.reconnectMs * 2, RECONNECT_MAX_MS)
      setTimeout(() => this.connect(), wait)
    }
    ws.addEventListener('close', onDown)
    ws.addEventListener('error', onDown)
  }

  private flushOutbox(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    const drained = this.outbox.splice(0, this.outbox.length)
    for (const msg of drained) {
      try {
        this.ws.send(JSON.stringify(msg))
      } catch {
        this.outbox.push(msg)
        break
      }
    }
  }
}
