import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import { runCli } from './cli.ts'
import { LocalStore } from './store.ts'

function newStore(): LocalStore {
  return new LocalStore(new Database(':memory:'))
}

describe('LocalStore', () => {
  it('upserts projects on add and round-trips them', () => {
    const store = newStore()
    store.addProject({ project_id: 'demo', project_path: '/tmp/demo' })
    expect(store.getProject('demo')).toMatchObject({
      project_id: 'demo',
      project_path: '/tmp/demo',
      default_branch: 'main',
      repo_policy: 'own',
    })

    // upsert: same id, different path
    store.addProject({
      project_id: 'demo',
      project_path: '/elsewhere',
      display_name: 'Demo Project',
    })
    expect(store.getProject('demo')?.project_path).toBe('/elsewhere')
    expect(store.getProject('demo')?.display_name).toBe('Demo Project')
  })

  it('lists, removes, and reports unknown ids', () => {
    const store = newStore()
    store.addProject({ project_id: 'a', project_path: '/a' })
    store.addProject({ project_id: 'b', project_path: '/b' })
    expect(
      store
        .listProjects()
        .map((p) => p.project_id)
        .sort(),
    ).toEqual(['a', 'b'])
    expect(store.removeProject('a')).toBe(true)
    expect(store.removeProject('a')).toBe(false)
    expect(store.listProjects().map((p) => p.project_id)).toEqual(['b'])
  })
})

describe('runCli', () => {
  it('handles add → list → rm', () => {
    const store = newStore()
    const out: string[] = []
    const log = (m: string) => out.push(m)

    expect(runCli(['project', 'add', 'demo', '/tmp/demo'], store, log)).toEqual({
      handled: true,
      exitCode: 0,
    })
    expect(runCli(['project', 'list'], store, log)).toEqual({ handled: true, exitCode: 0 })
    expect(runCli(['project', 'rm', 'demo'], store, log)).toEqual({ handled: true, exitCode: 0 })
    expect(runCli(['project', 'rm', 'demo'], store, log)).toEqual({ handled: true, exitCode: 1 })

    expect(out.some((l) => l.includes('added demo'))).toBe(true)
    expect(out.some((l) => l.includes('demo\town\tmain\t/tmp/demo'))).toBe(true)
    expect(out.some((l) => l.includes('removed demo'))).toBe(true)
    expect(out.some((l) => l.includes('not found: demo'))).toBe(true)
  })

  it('returns handled:false for unknown commands so supervisor can run', () => {
    const store = newStore()
    expect(runCli([], store, () => {})).toEqual({ handled: false, exitCode: 0 })
    expect(runCli(['nonsense'], store, () => {})).toEqual({ handled: false, exitCode: 0 })
  })

  it('rejects malformed add invocations', () => {
    const store = newStore()
    const out: string[] = []
    expect(runCli(['project', 'add'], store, (m) => out.push(m))).toEqual({
      handled: true,
      exitCode: 2,
    })
    expect(out[0]).toContain('usage')
  })
})
