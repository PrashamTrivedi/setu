import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface BunConfig {
  workerWs: string
  bearerToken: string
  machineId: string
  projects: Map<string, string> // project_id -> absolute project_path
  claudeBin: string
  socketPath: string
}

function parseProjects(raw: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const piece of raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const eq = piece.indexOf('=')
    if (eq < 0) continue
    const id = piece.slice(0, eq).trim()
    const path = piece.slice(eq + 1).trim()
    if (id && path) out.set(id, path)
  }
  return out
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
    projects: parseProjects(process.env.KANBAN_PROJECTS ?? ''),
    claudeBin: process.env.CLAUDE_BIN ?? 'claude',
    socketPath: process.env.KANBAN_SOCKET_PATH ?? defaultSocketPath(),
  }
}
