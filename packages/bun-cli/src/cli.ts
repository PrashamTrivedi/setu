import { resolve } from 'node:path'
import type { LocalStore } from './store.ts'

const HELP = `kanban-bun — Bun supervisor for kanban-channels

USAGE
  kanban-bun                       run the supervisor (default)
  kanban-bun project add <id> <path> [--name <s>] [--default-branch <s>] [--repo-policy own|client]
  kanban-bun project list
  kanban-bun project rm <id>
  kanban-bun help

ENVIRONMENT
  KANBAN_WORKER_WS       wss:// or ws:// URL to the Worker WS endpoint
  KANBAN_BEARER_TOKEN    must match the Worker's BUN_SHARED_TOKEN
  KANBAN_MACHINE_ID      free-form identifier for this machine
  KANBAN_DB_PATH         override the local SQLite store path
                         (default: $XDG_DATA_HOME/kanban-bun/state.db)
`

interface ParsedFlags {
  positional: string[]
  flags: Map<string, string>
}

function parseFlags(args: string[]): ParsedFlags {
  const positional: string[] = []
  const flags = new Map<string, string>()
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (!a) continue
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = args[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(key, next)
        i++
      } else {
        flags.set(key, 'true')
      }
    } else {
      positional.push(a)
    }
  }
  return { positional, flags }
}

export interface CliResult {
  handled: boolean
  exitCode: number
}

export function runCli(argv: string[], store: LocalStore, log = console.log): CliResult {
  const [cmd, sub, ...rest] = argv

  if (!cmd) return { handled: false, exitCode: 0 }

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    log(HELP)
    return { handled: true, exitCode: 0 }
  }

  if (cmd !== 'project') return { handled: false, exitCode: 0 }

  const { positional, flags } = parseFlags(rest)

  switch (sub) {
    case 'add': {
      const [id, path] = positional
      if (!id || !path) {
        log('usage: kanban-bun project add <id> <path>')
        return { handled: true, exitCode: 2 }
      }
      const row = store.addProject({
        project_id: id,
        project_path: resolve(path),
        display_name: flags.get('name'),
        default_branch: flags.get('default-branch'),
        repo_policy: (flags.get('repo-policy') as 'own' | 'client' | undefined) ?? undefined,
      })
      log(`added ${row.project_id} → ${row.project_path}`)
      return { handled: true, exitCode: 0 }
    }
    case 'list': {
      const rows = store.listProjects()
      if (rows.length === 0) {
        log('(no projects — add one with `kanban-bun project add <id> <path>`)')
      } else {
        for (const r of rows) {
          log(`${r.project_id}\t${r.repo_policy}\t${r.default_branch}\t${r.project_path ?? '-'}`)
        }
      }
      return { handled: true, exitCode: 0 }
    }
    case 'rm': {
      const [id] = positional
      if (!id) {
        log('usage: kanban-bun project rm <id>')
        return { handled: true, exitCode: 2 }
      }
      const ok = store.removeProject(id)
      log(ok ? `removed ${id}` : `not found: ${id}`)
      return { handled: true, exitCode: ok ? 0 : 1 }
    }
    default: {
      log(HELP)
      return { handled: true, exitCode: 2 }
    }
  }
}
