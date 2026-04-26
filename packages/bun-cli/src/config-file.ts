import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Resolution order for the kanban-bun config file:
 *   1. $KANBAN_ENV_FILE (explicit override)
 *   2. ./kanban-bun.env (per-project, opt-in)
 *   3. ./.env (only if running from packages/bun-cli — preserves repo dev flow)
 *   4. $XDG_CONFIG_HOME/kanban-bun/.env  (default: ~/.config/kanban-bun/.env)
 *
 * The first one that exists wins. We don't merge — the file is a single
 * source of truth.
 */
export function resolveConfigPath(): string | null {
  const candidates: string[] = []

  if (process.env.KANBAN_ENV_FILE) candidates.push(resolve(process.env.KANBAN_ENV_FILE))

  candidates.push(resolve(process.cwd(), 'kanban-bun.env'))

  const cwdEnv = resolve(process.cwd(), '.env')
  if (process.cwd().endsWith('/packages/bun-cli')) candidates.push(cwdEnv)

  const xdg = process.env.XDG_CONFIG_HOME
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.config')
  candidates.push(join(base, 'kanban-bun', '.env'))

  for (const path of candidates) {
    if (existsSync(path)) return path
  }
  return null
}

export function defaultConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.config')
  return join(base, 'kanban-bun', '.env')
}

/** Minimal `.env` parser. Mutates process.env, never overwriting existing keys. */
export function loadEnvFile(path: string): number {
  const text = readFileSync(path, 'utf8')
  let count = 0
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (process.env[key] === undefined) {
      process.env[key] = val
      count++
    }
  }
  return count
}
