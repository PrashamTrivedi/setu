import type { ChannelEvent, SessionRole } from '@kanban/protocol'
import type { Subprocess } from 'bun'
import type { BunConfig } from './config.ts'

export interface SessionHandle {
  project_id: string
  branch: string
  role: SessionRole
  proc: Subprocess
  cwd: string
  initial_event: ChannelEvent | null
}

export type SessionKey = string // `${project_id}::${branch}`
export const sessionKey = (project_id: string, branch: string): SessionKey =>
  `${project_id}::${branch}`

interface SpawnArgs {
  project_id: string
  project_path: string
  branch: string
  role: SessionRole
  cwd: string
  initial_event?: ChannelEvent
  channelServerEntry: string // absolute path to the channel server's index.ts
}

export class SessionRegistry {
  private cfg: BunConfig
  private byKey = new Map<SessionKey, SessionHandle>()

  constructor(cfg: BunConfig) {
    this.cfg = cfg
  }

  list(): SessionHandle[] {
    return [...this.byKey.values()]
  }

  has(project_id: string, branch: string): boolean {
    return this.byKey.has(sessionKey(project_id, branch))
  }

  get(project_id: string, branch: string): SessionHandle | undefined {
    return this.byKey.get(sessionKey(project_id, branch))
  }

  spawn(args: SpawnArgs): SessionHandle {
    const key = sessionKey(args.project_id, args.branch)
    const existing = this.byKey.get(key)
    if (existing && !existing.proc.killed) return existing

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      KANBAN_PROJECT_ID: args.project_id,
      KANBAN_BRANCH: args.branch,
      KANBAN_ROLE: args.role,
      KANBAN_SOCKET_PATH: this.cfg.socketPath,
    }

    // Claude Code with the channel loaded as a development plugin.
    // The channel server's stdio is owned by Claude (per requirement §5.3.1);
    // back-channel to Bun is via UDS.
    const proc = Bun.spawn(
      [
        this.cfg.claudeBin,
        '--dangerously-load-development-channels',
        `server:${args.role}=${args.channelServerEntry}`,
      ],
      {
        cwd: args.cwd,
        env,
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
      },
    )

    const handle: SessionHandle = {
      project_id: args.project_id,
      branch: args.branch,
      role: args.role,
      proc,
      cwd: args.cwd,
      initial_event: args.initial_event ?? null,
    }
    this.byKey.set(key, handle)
    void proc.exited.then(() => {
      this.byKey.delete(key)
    })
    return handle
  }

  terminate(project_id: string, branch: string, signal: NodeJS.Signals = 'SIGTERM'): boolean {
    const key = sessionKey(project_id, branch)
    const h = this.byKey.get(key)
    if (!h) return false
    try {
      h.proc.kill(signal)
    } catch {}
    this.byKey.delete(key)
    return true
  }
}
