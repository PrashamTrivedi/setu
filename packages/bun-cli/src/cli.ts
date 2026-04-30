import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import type { LocalStore } from './store.ts'

const HELP = `setu — Bun supervisor for kanban-channels

USAGE
  setu                              show this help
  setu supervisor                   run the long-lived supervisor (requires env)
  setu uninstall                    drop any prior user-scope channel MCP entries (cleanup)
  setu project add <id> <path> [--name <s>] [--default-branch <s>] [--repo-policy own|client]
  setu project list
  setu project rm <id>
  setu config path                  print the resolved config file path
  setu help

NOTE
  The channel MCP servers (kanban-work, kanban-ops) are NOT user-scope. Setu
  writes a per-session --mcp-config when it spawns each Claude process; that
  config is the only place these servers are registered. If you previously
  ran an older \`setu install\`, run \`setu uninstall\` once to clean up.

CONFIG / ENVIRONMENT
  Config file (auto-loaded for supervisor):
    \$XDG_CONFIG_HOME/setu/.env   (default: ~/.config/setu/.env)
    or ./.env in the current working directory

  Required for supervisor mode:
    KANBAN_WORKER_WS       wss:// or ws:// URL to the Worker WS endpoint
    KANBAN_BEARER_TOKEN    must match the Worker's BUN_SHARED_TOKEN

  Optional:
    KANBAN_MACHINE_ID      free-form identifier for this machine (default: hostname)
    KANBAN_DB_PATH         local SQLite store path
                           (default: \$XDG_DATA_HOME/setu/state.db)
    KANBAN_SOCKET_PATH     back-channel UDS path
                           (default: \$XDG_RUNTIME_DIR/setu.sock)
    CLAUDE_BIN             path to Claude Code binary (default: claude)

  Tmux-aware defaults:
    When run inside tmux (\$TMUX set), the *defaults* for socket path and
    machine id are scoped to the current tmux session+window so multiple
    setu supervisors can run side-by-side in different windows without
    colliding. Explicit KANBAN_SOCKET_PATH / KANBAN_MACHINE_ID always win.
      socket  → \$XDG_RUNTIME_DIR/setu-s<S>w<W>.sock
      machine → <baseMachineId>-s<S>w<W>
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

const CHANNEL_ROLES = ['kanban-work', 'kanban-ops'] as const

function claudeBin(): string {
  return process.env.CLAUDE_BIN ?? 'claude'
}

function runClaudeMcp(args: string[]): { code: number; stderr: string; stdout: string } {
  const r = spawnSync(claudeBin(), args, { encoding: 'utf8' })
  return {
    code: r.status ?? 1,
    stderr: r.stderr ?? '',
    stdout: r.stdout ?? '',
  }
}

function uninstallMcpServers(log: (msg: string) => void): number {
  for (const role of CHANNEL_ROLES) {
    const r = runClaudeMcp(['mcp', 'remove', role, '-s', 'user'])
    log(r.code === 0 ? `✓ removed ${role}` : `– ${role}: not registered`)
  }
  return 0
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

  if (cmd === 'uninstall') {
    return { handled: true, exitCode: uninstallMcpServers(log) }
  }

  if (cmd === 'config') {
    if (sub === 'path') {
      log(resolvedConfigPath ?? '(no config file resolved)')
      return { handled: true, exitCode: 0 }
    }
    log('usage: setu config path')
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
        log('usage: setu project add <id> <path>')
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
        log('(no projects — add one with `setu project add <id> <path>`)')
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
        log('usage: setu project rm <id>')
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
