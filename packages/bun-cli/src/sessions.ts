import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
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
  /** Per-session --mcp-config file; cleaned up on terminate. */
  mcpConfigPath: string
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
}

/** Absolute path to a channel server's source entry, relative to this file. */
function channelEntryPath(role: SessionRole): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here, '..', '..', 'channels', role, 'src', 'index.ts')
}

/**
 * Write a per-session MCP config and return its path. The file registers
 * exactly one server (the active role) so Claude doesn't try to spawn the
 * other role's channel — which would crash on the role-mismatch check.
 * Without `--strict-mcp-config`, the user's other MCP servers still load.
 */
function writeMcpConfig(role: SessionRole, project_id: string, branch: string): string {
  const dir = join(tmpdir(), 'setu-mcp')
  mkdirSync(dir, { recursive: true })
  const safeBranch = branch.replace(/[^A-Za-z0-9._-]/g, '_')
  const path = join(dir, `${role}-${project_id}-${safeBranch}.json`)
  const cfg = {
    mcpServers: {
      [role]: {
        command: 'bun',
        args: [channelEntryPath(role)],
      },
    },
  }
  writeFileSync(path, JSON.stringify(cfg))
  return path
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

    const mcpConfigPath = writeMcpConfig(args.role, args.project_id, args.branch)

    // Claude Code with the channel loaded as a development plugin. The
    // channel server is registered via per-session --mcp-config so it only
    // exists for this one Claude process — no pollution of the user's
    // ~/.claude.json, no role-mismatch crashes from the other role's server.
    // The channel server's stdio is owned by Claude (per requirement §5.3.1);
    // back-channel to Bun is via UDS.
    const proc = Bun.spawn(
      [
        this.cfg.claudeBin,
        '--mcp-config',
        mcpConfigPath,
        '--dangerously-load-development-channels',
        `server:${args.role}`,
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
      mcpConfigPath,
    }
    this.byKey.set(key, handle)
    void proc.exited.then(() => {
      this.byKey.delete(key)
      try {
        unlinkSync(mcpConfigPath)
      } catch {}
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
    try {
      unlinkSync(h.mcpConfigPath)
    } catch {}
    this.byKey.delete(key)
    return true
  }
}
