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

function defaultSocketPath(): string {
  const xdg = process.env.XDG_RUNTIME_DIR
  if (xdg && existsSync(xdg)) return join(xdg, 'kanban-bun.sock')
  return join(tmpdir(), `kanban-bun-${process.getuid?.() ?? 'user'}.sock`)
}

export function loadConfig(): BunConfig {
  const must = (k: string): string => {
    const v = process.env[k]
    if (!v) throw new Error(`missing required env var ${k}`)
    return v
  }
  return {
    workerWs: must('KANBAN_WORKER_WS'),
    bearerToken: must('KANBAN_BEARER_TOKEN'),
    machineId: process.env.KANBAN_MACHINE_ID ?? 'unnamed-machine',
    claudeBin: process.env.CLAUDE_BIN ?? 'claude',
    socketPath: process.env.KANBAN_SOCKET_PATH ?? defaultSocketPath(),
    dbPath: process.env.KANBAN_DB_PATH,
  }
}
