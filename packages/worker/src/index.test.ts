import { describe, expect, it } from 'vitest'

// Worker integration tests require @cloudflare/vitest-pool-workers + miniflare.
// Keeping a placeholder smoke test until that pool is wired up — the protocol
// state-machine logic is exercised in @kanban/protocol tests.
describe('worker module loads', () => {
  it('imports without throwing', async () => {
    // dynamic import so vitest does not try to evaluate worker globals at load
    const mod = await import('./project-do.ts').catch(() => null)
    expect(mod).toBeTruthy()
  })
})
