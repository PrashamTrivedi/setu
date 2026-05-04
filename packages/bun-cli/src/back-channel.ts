import { chmodSync, existsSync, unlinkSync } from 'node:fs'
import type { BackChannelHello, BunToChannel, ChannelToBun } from '@kanban/protocol'
import type { Socket } from 'bun'

type ChannelKey = string // `${project_id}::${branch}`

interface ChannelConn {
  socket: Socket<undefined>
  key: ChannelKey
  buf: string
}

export type OnChannelMessage = (key: ChannelKey, msg: ChannelToBun) => void

/**
 * Single-machine, single-user UDS. Filesystem permissions are the only auth.
 * Each spawned channel server connects, sends a `hello`, and is then
 * addressable by `(project_id, branch)`.
 */
export class BackChannelServer {
  private path: string
  private onMessage: OnChannelMessage
  private byKey = new Map<ChannelKey, ChannelConn>()
  // sockets that haven't said hello yet
  private pending = new Set<Socket<undefined>>()
  private bufs = new WeakMap<Socket<undefined>, string>()

  constructor(path: string, onMessage: OnChannelMessage) {
    this.path = path
    this.onMessage = onMessage
  }

  start(): void {
    if (existsSync(this.path)) {
      try {
        unlinkSync(this.path)
      } catch {}
    }
    Bun.listen<undefined>({
      unix: this.path,
      socket: {
        open: (s) => {
          this.pending.add(s)
          this.bufs.set(s, '')
        },
        data: (s, chunk) => this.onData(s, chunk),
        close: (s) => this.removeSocket(s),
        error: (s) => this.removeSocket(s),
      },
    })
    try {
      chmodSync(this.path, 0o600)
    } catch {}
  }

  send(key: ChannelKey, msg: BunToChannel): boolean {
    const conn = this.byKey.get(key)
    if (!conn) return false
    conn.socket.write(`${JSON.stringify(msg)}\n`)
    return true
  }

  has(key: ChannelKey): boolean {
    return this.byKey.has(key)
  }

  closeAll(reason: string): void {
    for (const conn of this.byKey.values()) {
      try {
        conn.socket.write(`${JSON.stringify({ type: 'shutdown', reason })}\n`)
      } catch {}
      try {
        conn.socket.end()
      } catch {}
    }
    this.byKey.clear()
    this.pending.clear()
  }

  private onData(s: Socket<undefined>, chunk: Buffer): void {
    let buf = (this.bufs.get(s) ?? '') + chunk.toString('utf8')
    while (true) {
      const nl = buf.indexOf('\n')
      if (nl === -1) break
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      let parsed: ChannelToBun
      try {
        parsed = JSON.parse(line) as ChannelToBun
      } catch {
        continue
      }
      this.dispatch(s, parsed)
    }
    this.bufs.set(s, buf)
  }

  private dispatch(s: Socket<undefined>, msg: ChannelToBun): void {
    if (msg.type === 'hello') {
      this.registerHello(s, msg)
      return
    }
    // find which key this socket belongs to
    let key: ChannelKey | undefined
    for (const [k, conn] of this.byKey)
      if (conn.socket === s) {
        key = k
        break
      }
    if (!key) return // not yet helloed; drop
    this.onMessage(key, msg)
  }

  private registerHello(s: Socket<undefined>, hello: BackChannelHello): void {
    const key: ChannelKey = `${hello.project_id}::${hello.branch}`
    // displace any prior conn under same key (re-spawn case)
    const prior = this.byKey.get(key)
    if (prior) {
      try {
        prior.socket.end()
      } catch {}
    }
    this.byKey.set(key, { socket: s, key, buf: '' })
    this.pending.delete(s)
    console.log(`[setu] channel hello: ${key} role=${hello.role} pid=${hello.pid}`)
  }

  private removeSocket(s: Socket<undefined>): void {
    this.pending.delete(s)
    this.bufs.delete(s)
    for (const [k, conn] of this.byKey) {
      if (conn.socket === s) {
        this.byKey.delete(k)
        break
      }
    }
  }
}
