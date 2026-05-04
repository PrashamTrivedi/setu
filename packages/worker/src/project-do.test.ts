import { webcrypto } from 'node:crypto'
import type { BunToWorker, Card, WorkerToBun } from '@kanban/protocol'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectDO } from './project-do.ts'
import type { CommittingAlarmRecord, FeedItem, PendingPermission } from './types.ts'

beforeAll(() => {
  const g = globalThis as unknown as { crypto?: Crypto }
  if (typeof g.crypto === 'undefined') {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
  } else if (typeof g.crypto.randomUUID !== 'function') {
    Object.defineProperty(g.crypto, 'randomUUID', {
      value: () => webcrypto.randomUUID(),
      configurable: true,
    })
  }
})

// ─── Fakes ───────────────────────────────────────────────────────────────────

class FakeStorage {
  private map = new Map<string, unknown>()
  private alarmAt: number | null = null
  async get<T>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.map.set(key, value)
  }
  async delete(key: string): Promise<boolean> {
    return this.map.delete(key)
  }
  async list<T>(opts?: { prefix?: string }): Promise<Map<string, T>> {
    const prefix = opts?.prefix ?? ''
    const out = new Map<string, T>()
    for (const [k, v] of this.map) {
      if (k.startsWith(prefix)) out.set(k, v as T)
    }
    return out
  }
  async setAlarm(at: number): Promise<void> {
    this.alarmAt = at
  }
  async getAlarm(): Promise<number | null> {
    return this.alarmAt
  }
  async deleteAlarm(): Promise<void> {
    this.alarmAt = null
  }
  // Test helpers
  _alarmAt(): number | null {
    return this.alarmAt
  }
  _entries(): [string, unknown][] {
    return [...this.map.entries()]
  }
}

class FakeStub {
  constructor(public onFetch: (req: Request) => Promise<Response>) {}
  fetch(input: string | Request, init?: RequestInit): Promise<Response> {
    const req =
      typeof input === 'string' ? new Request(input, init as RequestInit | undefined) : input
    return this.onFetch(req)
  }
}

interface MachineCall {
  msg: WorkerToBun
}

interface BroadcastCall {
  project_id: string
  item: FeedItem
}

interface SessionsLiveResp {
  sessions: { project_id: string; branch: string; role: string }[]
}

function makeEnv(opts: {
  machineCalls: MachineCall[]
  broadcastCalls: BroadcastCall[]
  sessionsLive?: SessionsLiveResp | 'not_found'
}) {
  const machineStub = new FakeStub(async (req) => {
    const url = new URL(req.url)
    if (url.pathname === '/send' && req.method === 'POST') {
      const msg = (await req.json()) as WorkerToBun
      opts.machineCalls.push({ msg })
      return Response.json({ ok: true })
    }
    if (url.pathname === '/sessions_live' && req.method === 'GET') {
      if (opts.sessionsLive === 'not_found') {
        return new Response('not found', { status: 404 })
      }
      const body = opts.sessionsLive ?? { sessions: [] }
      return Response.json(body)
    }
    return new Response('not found', { status: 404 })
  })
  const userStub = new FakeStub(async (req) => {
    const url = new URL(req.url)
    if (url.pathname === '/__broadcast' && req.method === 'POST') {
      const body = (await req.json()) as BroadcastCall
      opts.broadcastCalls.push(body)
      return Response.json({ ok: true })
    }
    return new Response('not found', { status: 404 })
  })

  return {
    PROJECT_DO: { idFromName: () => ({}), get: () => null } as unknown,
    MACHINE_DO: {
      idFromName: () => ({}),
      get: () => machineStub,
    } as unknown,
    USER_DO: {
      idFromName: () => ({}),
      get: () => userStub,
    } as unknown,
  } as Parameters<typeof makeProjectDO>[1]
}

function makeProjectDO(storage: FakeStorage, env: unknown): ProjectDO {
  const state = { storage } as unknown as DurableObjectState
  // biome-ignore lint/suspicious/noExplicitAny: test fake
  return new ProjectDO(state, env as any)
}

async function seedCard(storage: FakeStorage): Promise<Card> {
  const card: Card = {
    id: 'card-1',
    project_id: 'p1',
    title: 't',
    description: 'd',
    target_branch: 'b1',
    status: 'in_progress',
    created_at: 0,
    updated_at: 0,
    evidence: [],
    merge_strategy: 'squash',
    repo_policy: 'own',
  }
  await storage.put('card:card-1', card)
  await storage.put('machine_id', 'm1')
  return card
}

async function inbound(po: ProjectDO, msg: BunToWorker): Promise<void> {
  await po.fetch(
    new Request('https://internal/_inbound', {
      method: 'POST',
      body: JSON.stringify(msg),
      headers: { 'content-type': 'application/json' },
    }),
  )
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ProjectDO.dispatch', () => {
  let storage: FakeStorage
  let machineCalls: MachineCall[]
  let broadcastCalls: BroadcastCall[]
  let env: ReturnType<typeof makeEnv>
  let po: ProjectDO

  beforeEach(async () => {
    storage = new FakeStorage()
    machineCalls = []
    broadcastCalls = []
    env = makeEnv({ machineCalls, broadcastCalls })
    po = makeProjectDO(storage, env)
    await seedCard(storage)
  })

  it('1. noting dispatch — feed item stored, no alarm', async () => {
    await inbound(po, {
      type: 'reply_tool_call',
      project_id: 'p1',
      branch: 'b1',
      tool_call_id: 'tc1',
      tool_name: 'dispatch',
      role: 'kanban-ops',
      args: { card_id: 'card-1', body: 'fyi', kind: 'noting' },
    })
    const feed = await storage.list<FeedItem>({ prefix: 'feed:card-1:' })
    expect(feed.size).toBe(1)
    const item = [...feed.values()][0]
    expect(item?.kind).toBe('dispatch')
    if (item?.kind === 'dispatch') {
      expect(item.dispatch_kind).toBe('noting')
      expect(item.from_role).toBe('kanban-ops')
      expect(item.body).toBe('fyi')
      expect(item.committing).toBeUndefined()
    }
    expect(storage._alarmAt()).toBeNull()
    expect(broadcastCalls).toHaveLength(1)
  })

  it('2. committing dispatch — alarm scheduled with deadline', async () => {
    const before = Date.now()
    await inbound(po, {
      type: 'reply_tool_call',
      project_id: 'p1',
      branch: 'b1',
      tool_call_id: 'tc2',
      tool_name: 'dispatch',
      role: 'kanban-ops',
      args: {
        card_id: 'card-1',
        body: 'going with X',
        kind: 'committing',
        default_after_ms: 50,
      },
    })
    const alarms = await storage.list<CommittingAlarmRecord>({ prefix: 'alarm:' })
    expect(alarms.size).toBe(1)
    const rec = [...alarms.values()][0]
    if (!rec) throw new Error('expected alarm record')
    expect(rec.deadline).toBeGreaterThanOrEqual(before + 50)
    expect(storage._alarmAt()).toBe(rec.deadline)

    const feed = await storage.list<FeedItem>({ prefix: 'feed:card-1:' })
    const item = [...feed.values()][0]
    if (item?.kind === 'dispatch') {
      expect(item.committing?.default_after_ms).toBe(50)
      expect(item.committing?.resolved).toBeUndefined()
    } else {
      throw new Error('expected dispatch item')
    }
  })

  it('3. alarm fires — feed item resolved', async () => {
    await inbound(po, {
      type: 'reply_tool_call',
      project_id: 'p1',
      branch: 'b1',
      tool_call_id: 'tc3',
      tool_name: 'dispatch',
      role: 'kanban-ops',
      args: {
        card_id: 'card-1',
        body: 'going with X',
        kind: 'committing',
        default_after_ms: 1,
      },
    })
    // jump time
    const alarms = await storage.list<CommittingAlarmRecord>({ prefix: 'alarm:' })
    const rec = [...alarms.values()][0]
    if (!rec) throw new Error('expected alarm record')
    vi.useFakeTimers()
    vi.setSystemTime(new Date(rec.deadline + 1))
    await po.alarm()
    vi.useRealTimers()

    const feed = await storage.list<FeedItem>({ prefix: 'feed:card-1:' })
    const item = [...feed.values()][0]
    if (item?.kind === 'dispatch') {
      expect(item.committing?.resolved).toBe(true)
    } else {
      throw new Error('expected dispatch item')
    }
    const remaining = await storage.list<unknown>({ prefix: 'alarm:' })
    expect(remaining.size).toBe(0)
  })

  it('4. alarm fires with paired pending_input — input_response sent', async () => {
    await inbound(po, {
      type: 'reply_tool_call',
      project_id: 'p1',
      branch: 'b1',
      tool_call_id: 'tc-disp',
      tool_name: 'dispatch',
      role: 'kanban-ops',
      args: {
        card_id: 'card-1',
        body: 'going with X',
        kind: 'committing',
        default_after_ms: 1,
      },
    })
    // Worker emits a request_input next, which we pair into the committing alarm.
    await inbound(po, {
      type: 'reply_tool_call',
      project_id: 'p1',
      branch: 'b1',
      tool_call_id: 'tc-req',
      tool_name: 'request_input',
      role: 'kanban-ops',
      args: { card_id: 'card-1', prompt: 'OK?' },
    })

    const alarms = await storage.list<CommittingAlarmRecord>({ prefix: 'alarm:' })
    const rec = [...alarms.values()][0]
    if (!rec) throw new Error('expected alarm record')
    expect(rec.paired_request_tool_call_id).toBe('tc-req')

    vi.useFakeTimers()
    vi.setSystemTime(new Date(rec.deadline + 1))
    await po.alarm()
    vi.useRealTimers()

    const irCall = machineCalls.find(
      (c) =>
        c.msg.type === 'push_event' && c.msg.channel_event.meta.event_kind === 'input_response',
    )
    expect(irCall).toBeDefined()

    const card = await storage.get<Card>('card:card-1')
    expect(card?.pending_input).toBeNull()
  })

  it('5. dispatch with to_role + no live snapshot — no peer event, no throw', async () => {
    env = makeEnv({ machineCalls, broadcastCalls, sessionsLive: 'not_found' })
    po = makeProjectDO(storage, env)
    await inbound(po, {
      type: 'reply_tool_call',
      project_id: 'p1',
      branch: 'b1',
      tool_call_id: 'tc5',
      tool_name: 'dispatch',
      role: 'kanban-ops',
      args: { card_id: 'card-1', body: 'hey peer', kind: 'noting', to_role: 'kanban-work' },
    })
    const peer = machineCalls.find(
      (c) => c.msg.type === 'push_event' && c.msg.channel_event.meta.event_kind === 'peer_message',
    )
    expect(peer).toBeUndefined()
  })

  it('6. dispatch with to_role + matching live session — peer push_event', async () => {
    env = makeEnv({
      machineCalls,
      broadcastCalls,
      sessionsLive: {
        sessions: [{ project_id: 'p1', branch: 'b1', role: 'kanban-work' }],
      },
    })
    po = makeProjectDO(storage, env)
    await inbound(po, {
      type: 'reply_tool_call',
      project_id: 'p1',
      branch: 'b1',
      tool_call_id: 'tc6',
      tool_name: 'dispatch',
      role: 'kanban-ops',
      args: {
        card_id: 'card-1',
        body: 'check this',
        kind: 'noting',
        to_role: 'kanban-work',
      },
    })
    const peer = machineCalls.find(
      (c) => c.msg.type === 'push_event' && c.msg.channel_event.meta.event_kind === 'peer_message',
    )
    expect(peer).toBeDefined()
    if (peer && peer.msg.type === 'push_event') {
      expect(peer.msg.channel_event.meta.from_role).toBe('kanban-ops')
      expect(peer.msg.channel_event.meta.dispatch_kind).toBe('noting')
      expect(peer.msg.channel_event.meta.role).toBe('kanban-work')
    }
  })

  it('7. duplicate tool_call_id is dropped', async () => {
    const send = (id: string) =>
      inbound(po, {
        type: 'reply_tool_call',
        project_id: 'p1',
        branch: 'b1',
        tool_call_id: id,
        tool_name: 'dispatch',
        role: 'kanban-ops',
        args: { card_id: 'card-1', body: 'hey', kind: 'noting' },
      })
    await send('dup-1')
    await send('dup-1')
    const feed = await storage.list<FeedItem>({ prefix: 'feed:card-1:' })
    expect(feed.size).toBe(1)
  })
})

describe('ProjectDO.permission allowlist', () => {
  let storage: FakeStorage
  let machineCalls: MachineCall[]
  let broadcastCalls: BroadcastCall[]
  let po: ProjectDO

  beforeEach(async () => {
    storage = new FakeStorage()
    machineCalls = []
    broadcastCalls = []
    const env = makeEnv({ machineCalls, broadcastCalls })
    po = makeProjectDO(storage, env)
    await seedCard(storage)
  })

  async function permReq(req_id: string, branch = 'b1', preview = 'ls -la'): Promise<void> {
    await inbound(po, {
      type: 'permission_request',
      project_id: 'p1',
      branch,
      request_id: req_id,
      tool_name: 'Bash',
      description: 'list files',
      input_preview: preview,
    })
  }

  async function uiVerdict(
    request_id: string,
    behavior: 'allow' | 'deny',
    scope: 'once' | 'branch' | 'forever',
  ): Promise<void> {
    await po.fetch(
      new Request('https://internal/_ui_verdict', {
        method: 'POST',
        body: JSON.stringify({ request_id, behavior, scope }),
        headers: { 'content-type': 'application/json' },
      }),
    )
  }

  it('first request → no auto-allow, perm_ask in feed, pending row stored', async () => {
    await permReq('r1')
    const pending = await storage.get<PendingPermission>('pending_perms:r1')
    expect(pending).toBeDefined()
    const verdicts = machineCalls.filter((c) => c.msg.type === 'permission_verdict')
    expect(verdicts).toHaveLength(0)
    expect(broadcastCalls).toHaveLength(1)
    expect(broadcastCalls[0]?.item.kind).toBe('perm_ask')
  })

  it('branch verdict allows → second matching request auto-allows', async () => {
    await permReq('r1')
    await uiVerdict('r1', 'allow', 'branch')
    machineCalls.length = 0
    await permReq('r2')
    const verdicts = machineCalls.filter(
      (c) => c.msg.type === 'permission_verdict' && c.msg.behavior === 'allow',
    )
    expect(verdicts).toHaveLength(1)
  })

  it('branch verdict does not match a different branch', async () => {
    await permReq('r1', 'b1')
    await uiVerdict('r1', 'allow', 'branch')
    machineCalls.length = 0
    await permReq('r2', 'b2')
    const verdicts = machineCalls.filter((c) => c.msg.type === 'permission_verdict')
    expect(verdicts).toHaveLength(0) // still asks
    const pending = await storage.get<PendingPermission>('pending_perms:r2')
    expect(pending).toBeDefined()
  })

  it('forever verdict allows across branches', async () => {
    await permReq('r1', 'b1')
    await uiVerdict('r1', 'allow', 'forever')
    machineCalls.length = 0
    await permReq('r2', 'b2')
    const verdicts = machineCalls.filter(
      (c) => c.msg.type === 'permission_verdict' && c.msg.behavior === 'allow',
    )
    expect(verdicts).toHaveLength(1)
  })

  it('once verdict does not write any allowlist row', async () => {
    await permReq('r1', 'b1')
    await uiVerdict('r1', 'allow', 'once')
    const rows = await storage.list({ prefix: 'allow:' })
    expect(rows.size).toBe(0)
  })

  it('whitespace-different previews fingerprint-match for allowlist hit', async () => {
    await permReq('r1', 'b1', 'ls -la')
    await uiVerdict('r1', 'allow', 'branch')
    machineCalls.length = 0
    await permReq('r2', 'b1', '  LS    -la  ')
    const verdicts = machineCalls.filter(
      (c) => c.msg.type === 'permission_verdict' && c.msg.behavior === 'allow',
    )
    expect(verdicts).toHaveLength(1)
  })
})
