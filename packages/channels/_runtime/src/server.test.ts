import { describe, expect, it } from 'vitest'
import { helpers } from './server.ts'

describe('channel runtime helpers', () => {
  it('newRequestId returns 5 letters with no l', () => {
    for (let i = 0; i < 200; i++) {
      const id = helpers.newRequestId()
      expect(id).toMatch(/^[a-km-z]{5}$/)
    }
  })

  it('newToolCallId returns a uuid', () => {
    const id = helpers.newToolCallId()
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
  })
})
