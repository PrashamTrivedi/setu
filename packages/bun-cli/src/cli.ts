import { resolve } from 'node:path'
import type { LocalStore } from './store.ts'

const HELP = `kanban-bun — Bun supervisor for kanban-channels

USAGE
  kanban-bun                       show this help
  kanban-bun supervisor            run the long-lived supervisor (requires env)
  kanban-bun project add <id> <path> [--name <s>] [--default-branch <s>] [--repo-policy own|client]
  kanban-bun project list
  kanban-bun project rm <id>
  kanban-bun config path           print the resolved config file path
  kanban-bun help

CONFIG / ENVIRONMENT
  Config file (auto-loaded for supervisor):
    \$XDG_CONFIG_HOME/kanban-bun/.env   (default: ~/.config/kanban-bun/.env)
    or ./.env in the current working directory

  Required for supervisor mode:
    KANBAN_WORKER_WS       wss:// or ws:// URL to the Worker WS endpoint
    KANBAN_BEARER_TOKEN    must match the Worker's BUN_SHARED_TOKEN

  Optional:
    KANBAN_MACHINE_ID      free-form identifier for this machine (default: hostname)
    KANBAN_DB_PATH         local SQLite store path
                           (default: \$XDG_DATA_HOME/kanban-bun/state.db)
    KANBAN_SOCKET_PATH     back-channel UDS path
                           (default: \$XDG_RUNTIME_DIR/kanban-bun.sock)
    CLAUDE_BIN             path to Claude Code binary (default: claude)
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
  /** true = CLI handled this invocation; false = continue into supervisor */
  handled: boolean
  exitCode: number
  /** When false, caller should boot the supervisor */
  runSupervisor?: boolean
}

export function runCli(
  argv: string[],
  store: LocalStore,
  log: (msg: string) => void = console.log,
  resolvedConfigPath?: string,
): CliResult {
  const [cmd, sub, ...rest] = argv

  // No args → print help. Don't fall through to supervisor.
  if (!cmd) {
    log(HELP)
    return { handled: true, exitCode: 0 }
  }

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    log(HELP)
    return { handled: true, exitCode: 0 }
  }

  if (cmd === 'supervisor' || cmd === 'start') {
    return { handled: false, exitCode: 0, runSupervisor: true }
  }

  if (cmd === 'config') {
    if (sub === 'path') {
      log(resolvedConfigPath ?? '(no config file resolved)')
      return { handled: true, exitCode: 0 }
    }
    log('usage: kanban-bun config path')
    return { handled: true, exitCode: 2 }
  }

  if (cmd !== 'project') {
    log(`unknown command: ${cmd}\n`)
    log(HELP)
    return { handled: true, exitCode: 2 }
  }

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
