import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig, tmuxKeyFrom, type TmuxInfo } from './config.ts'

const KEYS = [
  'KANBAN_WORKER_WS',
  'KANBAN_BEARER_TOKEN',
  'KANBAN_MACHINE_ID',
  'CLAUDE_BIN',
  'KANBAN_SOCKET_PATH',
  'KANBAN_DB_PATH',
  'TMUX',
] as const

const snapshot: Record<string, string | undefined> = {}
for (const k of KEYS) snapshot[k] = process.env[k]

beforeEach(() => {
  // Silence the [setu] tmux:... log lines during tests.
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  for (const k of KEYS) {
    if (snapshot[k] === undefined) delete process.env[k]
    else process.env[k] = snapshot[k]
  }
  vi.restoreAllMocks()
})

describe('loadConfig', () => {
  it('reads worker URL, bearer, machine id, and optional db path', () => {
    process.env.KANBAN_WORKER_WS = 'wss://x.example/ws/bun/demo'
    process.env.KANBAN_BEARER_TOKEN = 'token'
    process.env.KANBAN_MACHINE_ID = 'rig-7'
    process.env.KANBAN_DB_PATH = '/tmp/state.db'
    const cfg = loadConfig({ tmuxProbe: () => null })
    expect(cfg.workerWs).toBe('wss://x.example/ws/bun/demo')
    expect(cfg.bearerToken).toBe('token')
    expect(cfg.machineId).toBe('rig-7')
    expect(cfg.dbPath).toBe('/tmp/state.db')
  })

  it('throws on missing required env vars', () => {
    delete process.env.KANBAN_WORKER_WS
    delete process.env.KANBAN_BEARER_TOKEN
    expect(() => loadConfig({ tmuxProbe: () => null })).toThrow(/KANBAN_WORKER_WS/)
  })
})

describe('tmuxKeyFrom', () => {
  it('strips $@% sigils and produces s<S>w<W>', () => {
    expect(tmuxKeyFrom('$0', '@3')).toBe('s0w3')
    expect(tmuxKeyFrom('$12', '@7')).toBe('s12w7')
    expect(tmuxKeyFrom('%5', '@0')).toBe('s5w0')
  })
})

describe('loadConfig tmux scoping', () => {
  beforeEach(() => {
    process.env.KANBAN_WORKER_WS = 'wss://x.example/ws/bun/demo'
    process.env.KANBAN_BEARER_TOKEN = 'token'
    delete process.env.KANBAN_MACHINE_ID
    delete process.env.KANBAN_SOCKET_PATH
    delete process.env.TMUX
  })

  it('without tmux: defaults are unchanged (no suffix)', () => {
    const cfg = loadConfig({ tmuxProbe: () => null })
    expect(cfg.machineId).toBe('unnamed-machine')
    // No suffix in the socket path.
    expect(cfg.socketPath).toMatch(/setu\.sock$/)
    expect(cfg.socketPath).not.toMatch(/setu-s\d+w\d+\.sock$/)
  })

  it('tmux present + defaults: socket and machineId both scoped by tmux key', () => {
    const tmux: TmuxInfo = { sessionId: '$0', windowId: '@3', key: 's0w3' }
    const cfg = loadConfig({ tmuxProbe: () => tmux })
    expect(cfg.machineId).toBe('unnamed-machine-s0w3')
    expect(cfg.socketPath).toMatch(/setu-s0w3\.sock$/)
  })

  it('tmux present + KANBAN_MACHINE_ID set: machineId override is respected (no suffix)', () => {
    process.env.KANBAN_MACHINE_ID = 'rig-7'
    const tmux: TmuxInfo = { sessionId: '$0', windowId: '@3', key: 's0w3' }
    const cfg = loadConfig({ tmuxProbe: () => tmux })
    expect(cfg.machineId).toBe('rig-7')
    // socket still scoped (only that env var was overridden).
    expect(cfg.socketPath).toMatch(/setu-s0w3\.sock$/)
  })

  it('tmux present + KANBAN_SOCKET_PATH set: socket override is respected', () => {
    process.env.KANBAN_SOCKET_PATH = '/tmp/custom-setu.sock'
    const tmux: TmuxInfo = { sessionId: '$0', windowId: '@3', key: 's0w3' }
    const cfg = loadConfig({ tmuxProbe: () => tmux })
    expect(cfg.socketPath).toBe('/tmp/custom-setu.sock')
    // machineId still scoped (only that env var was overridden).
    expect(cfg.machineId).toBe('unnamed-machine-s0w3')
  })

  it('tmux present + both env vars overridden: neither gets the tmux suffix', () => {
    process.env.KANBAN_MACHINE_ID = 'rig-7'
    process.env.KANBAN_SOCKET_PATH = '/tmp/custom-setu.sock'
    const tmux: TmuxInfo = { sessionId: '$0', windowId: '@3', key: 's0w3' }
    const cfg = loadConfig({ tmuxProbe: () => tmux })
    expect(cfg.machineId).toBe('rig-7')
    expect(cfg.socketPath).toBe('/tmp/custom-setu.sock')
  })

  it('two tmux windows produce two distinct socket paths and machine ids', () => {
    const a: TmuxInfo = { sessionId: '$0', windowId: '@3', key: 's0w3' }
    const b: TmuxInfo = { sessionId: '$0', windowId: '@4', key: 's0w4' }
    const cfgA = loadConfig({ tmuxProbe: () => a })
    const cfgB = loadConfig({ tmuxProbe: () => b })
    expect(cfgA.socketPath).not.toBe(cfgB.socketPath)
    expect(cfgA.machineId).not.toBe(cfgB.machineId)
  })
})
