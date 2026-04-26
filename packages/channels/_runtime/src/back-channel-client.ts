import type { BunToChannel, ChannelToBun, SessionRole } from '@kanban/protocol'
import type { Socket } from 'bun'

export interface BackChannelOptions {
  socketPath: string
  project_id: string
  branch: string
  role: SessionRole
  onIncoming: (msg: BunToChannel) => void
}

/**
 * Connects to the Bun supervisor's UDS, says hello, and exposes a `send`
 * helper. Reconnects with backoff if Bun is restarted under us — but the
 * happy path keeps a single connection for the life of the channel server.
 */
export async function connectBackChannel(opts: BackChannelOptions): Promise<{
  send: (msg: ChannelToBun) => void
}> {
  let socket: Socket<undefined> | null = null
  let buf = ''
  let connecting: Promise<void> | null = null
  let backoff = 500

  const open = (): Promise<void> => {
    if (connecting) return connecting
    connecting = new Promise<void>((resolveConn, rejectConn) => {
      Bun.connect<undefined>({
        unix: opts.socketPath,
        socket: {
          open: (s) => {
            socket = s
            backoff = 500
            const hello: ChannelToBun = {
              type: 'hello',
              project_id: opts.project_id,
              branch: opts.branch,
              role: opts.role,
              pid: process.pid,
            }
            s.write(`${JSON.stringify(hello)}\n`)
            resolveConn()
          },
          data: (_s, chunk) => {
            buf += chunk.toString('utf8')
            while (true) {
              const nl = buf.indexOf('\n')
              if (nl === -1) break
              const line = buf.slice(0, nl).trim()
              buf = buf.slice(nl + 1)
              if (!line) continue
              try {
                const parsed = JSON.parse(line) as BunToChannel
                opts.onIncoming(parsed)
              } catch {}
            }
          },
          close: () => {
            socket = null
            connecting = null
            scheduleReconnect()
          },
          error: (_s, err) => {
            socket = null
            connecting = null
            rejectConn(err)
            scheduleReconnect()
          },
        },
      }).catch((err) => {
        connecting = null
        scheduleReconnect()
        rejectConn(err)
      })
    })
    return connecting
  }

  const scheduleReconnect = () => {
    const wait = Math.min(backoff, 30_000)
    backoff = Math.min(backoff * 2, 30_000)
    setTimeout(() => {
      void open().catch(() => {})
    }, wait)
  }

  await open()

  return {
    send(msg: ChannelToBun) {
      const s = socket
      if (!s) return
      try {
        s.write(`${JSON.stringify(msg)}\n`)
      } catch {}
    },
  }
}
