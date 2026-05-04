import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
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
  /** When running outside tmux, the in-process child handle. */
  proc?: Subprocess
  /** When running inside tmux, the window the Claude is hosted in. */
  tmuxWindowId?: string
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

/**
 * Absolute path to a channel server's source entry.
 *
 * Two resolution paths:
 *   1. `SETU_CHANNEL_DIR` env var (set this when running the compiled binary,
 *      because `import.meta.url` inside Bun's `--compile` output points into
 *      the embedded VFS, not a real file on disk). Expected layout:
 *        $SETU_CHANNEL_DIR/<role>/src/index.ts
 *   2. Resolution from `import.meta.url` for dev / `bun link` mode where the
 *      monorepo is on disk.
 *
 * Throws if the resolved path does not exist on disk — without this the user
 * sees a confusing "kanban-work · ✘ failed" inside Claude with no Bun-side
 * error.
 */
function channelEntryPath(role: SessionRole): string {
  const override = process.env.SETU_CHANNEL_DIR
  const candidate = override
    ? resolve(override, role, 'src', 'index.ts')
    : (() => {
        const here = dirname(fileURLToPath(import.meta.url))
        return resolve(here, '..', '..', 'channels', role, 'src', 'index.ts')
      })()
  if (!existsSync(candidate)) {
    const hint = override
      ? `SETU_CHANNEL_DIR=${override} but ${candidate} doesn't exist`
      : `derived ${candidate} not found — set SETU_CHANNEL_DIR to your repo's packages/channels (required when running the compiled \`setu\` binary)`
    throw new Error(`channel server source missing for role=${role}: ${hint}`)
  }
  return candidate
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

function tmuxWindowName(role: SessionRole, project_id: string, branch: string): string {
  const roleShort = role === 'kanban-ops' ? 'ops' : 'work'
  // tmux truncates window names in the status line — keep it readable.
  const name = `${roleShort}:${project_id}/${branch}`
  return name.length > 60 ? `${name.slice(0, 57)}…` : name
}

function isHandleAlive(h: SessionHandle): boolean {
  if (h.tmuxWindowId) {
    // Verify the window still exists. If tmux command fails (no tmux on
    // PATH, or the window was killed manually), treat as dead.
    const r = spawnSync('tmux', ['list-windows', '-F', '#{window_id}'], { encoding: 'utf8' })
    if (r.status !== 0) return false
    const ids = (r.stdout ?? '').split(/\s+/).filter(Boolean)
    return ids.includes(h.tmuxWindowId)
  }
  return !!h.proc && !h.proc.killed
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
    if (existing && isHandleAlive(existing)) {
      // "Resume" semantics: if running in tmux, surface the live window so
      // the user can see it. Outside tmux, the child still owns the
      // supervisor's stdio (legacy behavior) — nothing to surface.
      if (existing.tmuxWindowId) {
        spawnSync('tmux', ['select-window', '-t', existing.tmuxWindowId])
      }
      return existing
    }
    if (existing) this.byKey.delete(key)

    const childEnv: Record<string, string> = {
      KANBAN_PROJECT_ID: args.project_id,
      KANBAN_BRANCH: args.branch,
      KANBAN_ROLE: args.role,
      KANBAN_SOCKET_PATH: this.cfg.socketPath,
    }

    const mcpConfigPath = writeMcpConfig(args.role, args.project_id, args.branch)

    const claudeArgv = [
      this.cfg.claudeBin,
      '--mcp-config',
      mcpConfigPath,
      '--dangerously-load-development-channels',
      `server:${args.role}`,
    ]

    if (this.cfg.tmux) {
      const handle = this.spawnInTmux(args, claudeArgv, childEnv, mcpConfigPath)
      this.byKey.set(key, handle)
      return handle
    }

    // Non-tmux fallback — child inherits the supervisor's stdio.
    const proc = Bun.spawn(claudeArgv, {
      cwd: args.cwd,
      env: { ...(process.env as Record<string, string>), ...childEnv },
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    })
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

  private spawnInTmux(
    args: SpawnArgs,
    claudeArgv: string[],
    childEnv: Record<string, string>,
    mcpConfigPath: string,
  ): SessionHandle {
    const winName = tmuxWindowName(args.role, args.project_id, args.branch)
    const tmuxArgs = [
      'new-window',
      '-d', // create detached so the supervisor's window isn't switched away
      '-P', // print info about the new window
      '-F',
      '#{window_id}',
      '-n',
      winName,
      '-c',
      args.cwd,
    ]
    // Forward the supervisor's PATH and a handful of other common vars so
    // `claude` and `bun` (the MCP `command`) actually resolve in the new
    // window. tmux's captured global env may not include ~/.bun/bin etc.
    const inherit: Record<string, string | undefined> = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      USER: process.env.USER,
      LANG: process.env.LANG,
      TERM: process.env.TERM,
      SHELL: process.env.SHELL,
      SETU_CHANNEL_DIR: process.env.SETU_CHANNEL_DIR,
    }
    const childMerged: Record<string, string> = {}
    for (const [k, v] of Object.entries(inherit)) if (v != null) childMerged[k] = v
    Object.assign(childMerged, childEnv)
    for (const [k, v] of Object.entries(childMerged)) {
      tmuxArgs.push('-e', `${k}=${v}`)
    }
    // Append the actual command. tmux runs it via the user's default shell.
    tmuxArgs.push('--', ...claudeArgv)

    const r = spawnSync('tmux', tmuxArgs, { encoding: 'utf8' })
    if (r.status !== 0) {
      const err = (r.stderr ?? '').trim() || `exit ${r.status}`
      throw new Error(`tmux new-window failed: ${err}`)
    }
    const windowId = (r.stdout ?? '').trim()
    if (!windowId) {
      throw new Error('tmux new-window did not return a window id')
    }
    // Keep the window around if the command exits — the user needs to see
    // crash output when Claude or the channel server fails to start.
    spawnSync('tmux', ['set-window-option', '-t', windowId, 'remain-on-exit', 'on'])
    console.log(
      `[setu] spawned ${args.role} for ${args.project_id}/${args.branch} → tmux window ${windowId} (${winName})`,
    )
    return {
      project_id: args.project_id,
      branch: args.branch,
      role: args.role,
      tmuxWindowId: windowId,
      cwd: args.cwd,
      initial_event: args.initial_event ?? null,
      mcpConfigPath,
    }
  }

  terminate(project_id: string, branch: string, signal: NodeJS.Signals = 'SIGTERM'): boolean {
    const key = sessionKey(project_id, branch)
    const h = this.byKey.get(key)
    if (!h) return false
    if (h.tmuxWindowId) {
      spawnSync('tmux', ['kill-window', '-t', h.tmuxWindowId])
    } else if (h.proc) {
      try {
        h.proc.kill(signal)
      } catch {}
    }
    try {
      unlinkSync(h.mcpConfigPath)
    } catch {}
    this.byKey.delete(key)
    return true
  }
}
