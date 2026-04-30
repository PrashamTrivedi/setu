import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface BunConfig {
  workerWs: string
  bearerToken: string
  machineId: string
  claudeBin: string
  socketPath: string
  /** Override for the local SQLite store. Empty = use defaultDbPath(). */
  dbPath?: string
}

export interface TmuxInfo {
  sessionId: string
  windowId: string
  /** Filesystem-safe key derived from session+window (e.g. "s0w3"). */
  key: string
}

/**
 * Probe tmux for the current session+window when $TMUX is set.
 * Returns null when not in a tmux session or the probe fails.
 *
 * Exposed (and injectable via loadConfig({ tmuxProbe })) so tests don't have
 * to shell out to a real tmux binary.
 */
export function detectTmux(env: NodeJS.ProcessEnv = process.env): TmuxInfo | null {
  if (!env.TMUX) return null
  try {
    const r = spawnSync('tmux', ['display', '-p', '#{session_id} #{window_id}'], {
      encoding: 'utf8',
    })
    if (r.status !== 0) return null
    const out = (r.stdout ?? '').trim()
    if (!out) return null
    const [sessionId, windowId] = out.split(/\s+/)
    if (!sessionId || !windowId) return null
    return { sessionId, windowId, key: tmuxKeyFrom(sessionId, windowId) }
  } catch {
    return null
  }
}

/** Strip tmux sigils ($, @, %) so the result is filesystem-safe. */
export function tmuxKeyFrom(sessionId: string, windowId: string): string {
  const s = sessionId.replace(/[$@%]/g, '')
  const w = windowId.replace(/[$@%]/g, '')
  return `s${s}w${w}`
}

function defaultSocketPath(suffix?: string): string {
  const tag = suffix ? `-${suffix}` : ''
  const xdg = process.env.XDG_RUNTIME_DIR
  if (xdg && existsSync(xdg)) return join(xdg, `setu${tag}.sock`)
  return join(tmpdir(), `setu-${process.getuid?.() ?? 'user'}${tag}.sock`)
}

export interface LoadConfigOptions {
  /**
   * Optional injectable probe. Defaults to {@link detectTmux}. Tests can pass
   * a stub that returns canned values without spawning a real tmux process.
   */
  tmuxProbe?: () => TmuxInfo | null
  /** Optional env override (defaults to process.env). Useful in tests. */
  env?: NodeJS.ProcessEnv
}

export function loadConfig(opts: LoadConfigOptions = {}): BunConfig {
  const env = opts.env ?? process.env
  const must = (k: string): string => {
    const v = env[k]
    if (!v) throw new Error(`missing required env var ${k}`)
    return v
  }

  const probe = opts.tmuxProbe ?? (() => detectTmux(env))
  const tmux = probe()

  // baseMachineId = what KANBAN_MACHINE_ID would have resolved to without tmux.
  const userMachineId = env.KANBAN_MACHINE_ID
  const baseMachineId = userMachineId ?? 'unnamed-machine'
  const userSocketPath = env.KANBAN_SOCKET_PATH

  // Tmux scoping is applied only to defaults. Explicit env overrides win.
  const machineId =
    tmux && !userMachineId ? `${baseMachineId}-${tmux.key}` : baseMachineId
  const socketPath =
    userSocketPath ?? defaultSocketPath(tmux ? tmux.key : undefined)

  if (tmux) {
    console.log(
      `[setu] tmux detected: session=${tmux.sessionId} window=${tmux.windowId} → machineId=${machineId}`,
    )
  } else {
    console.log('[setu] tmux: not in a tmux session')
  }

  return {
    workerWs: must('KANBAN_WORKER_WS'),
    bearerToken: must('KANBAN_BEARER_TOKEN'),
    machineId,
    claudeBin: env.CLAUDE_BIN ?? 'claude',
    socketPath,
    dbPath: env.KANBAN_DB_PATH,
  }
}
