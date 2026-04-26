import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from './config.ts'

const KEYS = [
  'KANBAN_WORKER_WS',
  'KANBAN_BEARER_TOKEN',
  'KANBAN_MACHINE_ID',
  'CLAUDE_BIN',
  'KANBAN_SOCKET_PATH',
  'KANBAN_DB_PATH',
] as const

const snapshot: Record<string, string | undefined> = {}
for (const k of KEYS) snapshot[k] = process.env[k]

afterEach(() => {
  for (const k of KEYS) {
    if (snapshot[k] === undefined) delete process.env[k]
    else process.env[k] = snapshot[k]
  }
})

describe('loadConfig', () => {
  it('reads worker URL, bearer, machine id, and optional db path', () => {
    process.env.KANBAN_WORKER_WS = 'wss://x.example/ws/bun/demo'
    process.env.KANBAN_BEARER_TOKEN = 'token'
    process.env.KANBAN_MACHINE_ID = 'rig-7'
    process.env.KANBAN_DB_PATH = '/tmp/state.db'
    const cfg = loadConfig()
    expect(cfg.workerWs).toBe('wss://x.example/ws/bun/demo')
    expect(cfg.bearerToken).toBe('token')
    expect(cfg.machineId).toBe('rig-7')
    expect(cfg.dbPath).toBe('/tmp/state.db')
  })

  it('throws on missing required env vars', () => {
    delete process.env.KANBAN_WORKER_WS
    delete process.env.KANBAN_BEARER_TOKEN
    expect(() => loadConfig()).toThrow(/KANBAN_WORKER_WS/)
  })
})
