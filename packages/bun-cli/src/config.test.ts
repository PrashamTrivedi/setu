import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from './config.ts'

const KEYS = [
  'KANBAN_WORKER_WS',
  'KANBAN_BEARER_TOKEN',
  'KANBAN_MACHINE_ID',
  'KANBAN_PROJECTS',
  'CLAUDE_BIN',
  'KANBAN_SOCKET_PATH',
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
  it('parses KANBAN_PROJECTS into a map', () => {
    process.env.KANBAN_WORKER_WS = 'wss://x.example/ws/bun/demo'
    process.env.KANBAN_BEARER_TOKEN = 'token'
    process.env.KANBAN_PROJECTS = 'demo=/tmp/demo, sun=/tmp/sun'
    const cfg = loadConfig()
    expect(cfg.projects.get('demo')).toBe('/tmp/demo')
    expect(cfg.projects.get('sun')).toBe('/tmp/sun')
  })

  it('throws on missing required env vars', () => {
    delete process.env.KANBAN_WORKER_WS
    delete process.env.KANBAN_BEARER_TOKEN
    expect(() => loadConfig()).toThrow(/KANBAN_WORKER_WS/)
  })
})
