import { describe, expect, it } from 'vitest'
import { canTransition, nextStatuses } from './domain.ts'

describe('card status state machine', () => {
  it('allows the happy-path transitions through to archived', () => {
    const path = [
      'backlog',
      'assigned',
      'in_progress',
      'done-pending-review',
      'approved',
      'merging',
      'merged',
      'cleaning',
      'archived',
    ] as const
    for (let i = 0; i < path.length - 1; i++) {
      const from = path[i]
      const to = path[i + 1]
      if (!from || !to) throw new Error('unreachable')
      expect(canTransition(from, to)).toBe(true)
    }
  })

  it('blocks illegal jumps', () => {
    expect(canTransition('backlog', 'merged')).toBe(false)
    expect(canTransition('archived', 'backlog')).toBe(false)
    expect(canTransition('in_progress', 'archived')).toBe(false)
  })

  it('allows recovery from merge_failed back to merging', () => {
    expect(canTransition('merge_failed', 'merging')).toBe(true)
    expect(nextStatuses('clean_failed')).toContain('cleaning')
  })
})
