import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

/**
 * Resolution order for the setu config file:
 *   1. $KANBAN_ENV_FILE (explicit override)
 *   2. ./setu.env (per-project, opt-in)
 *   3. ./.env (only if running from packages/bun-cli — preserves repo dev flow)
 *   4. $XDG_CONFIG_HOME/setu/.env  (default: ~/.config/setu/.env)
 *
 * The first one that exists wins. We don't merge — the file is a single
 * source of truth.
 */
export function resolveConfigPath(): string | null {
  const candidates: string[] = []

  if (process.env.KANBAN_ENV_FILE) candidates.push(resolve(process.env.KANBAN_ENV_FILE))

  candidates.push(resolve(process.cwd(), 'setu.env'))

  const cwdEnv = resolve(process.cwd(), '.env')
  if (process.cwd().endsWith('/packages/bun-cli')) candidates.push(cwdEnv)

  const xdg = process.env.XDG_CONFIG_HOME
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.config')
  candidates.push(join(base, 'setu', '.env'))

  for (const path of candidates) {
    if (existsSync(path)) return path
  }
  return null
}

export function defaultConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.config')
  return join(base, 'setu', '.env')
}

/** Resolved `~/.config/setu` (honors `$XDG_CONFIG_HOME`). */
export function setuConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.config')
  return join(base, 'setu')
}

/** Where named profile files live: `<configDir>/profiles/<name>.env`. */
export function profilesDir(): string {
  return join(setuConfigDir(), 'profiles')
}

/** Lists `<name>.env` files under {@link profilesDir}, sorted by name. */
export function listProfiles(): Array<{ name: string; path: string }> {
  const dir = profilesDir()
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.env'))
    .map((f) => ({ name: f.slice(0, -'.env'.length), path: join(dir, f) }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Returns the currently active profile name, or null if `<configDir>/.env`
 * isn't a symlink into `profiles/`.
 */
export function activeProfileName(): string | null {
  const link = join(setuConfigDir(), '.env')
  try {
    if (!lstatSync(link).isSymbolicLink()) return null
    const target = readlinkSync(link)
    const resolved = resolve(setuConfigDir(), target)
    if (dirname(resolved) !== profilesDir()) return null
    const file = basename(resolved)
    if (!file.endsWith('.env')) return null
    return file.slice(0, -'.env'.length)
  } catch {
    return null
  }
}

export type UseProfileResult =
  | { ok: true; path: string; configPath: string }
  | { ok: false; reason: string }

/**
 * Atomically point `<configDir>/.env` at `profiles/<name>.env`. Refuses to
 * clobber an existing regular file at `<configDir>/.env` so a hand-written
 * config isn't silently lost.
 */
export function useProfile(name: string): UseProfileResult {
  const target = join(profilesDir(), `${name}.env`)
  if (!existsSync(target)) {
    return { ok: false, reason: `profile not found: ${target}` }
  }
  const dir = setuConfigDir()
  mkdirSync(dir, { recursive: true })
  const link = join(dir, '.env')
  try {
    const stat = lstatSync(link)
    if (!stat.isSymbolicLink()) {
      return {
        ok: false,
        reason: `${link} is a regular file — move it to profiles/<name>.env first so it isn't lost`,
      }
    }
  } catch {
    // missing → fine
  }
  const tmp = join(dir, `.env.tmp.${process.pid}`)
  try {
    rmSync(tmp, { force: true })
  } catch {}
  // Relative target keeps the symlink valid if the config dir is moved.
  symlinkSync(`profiles/${name}.env`, tmp)
  renameSync(tmp, link)
  return { ok: true, path: target, configPath: link }
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
