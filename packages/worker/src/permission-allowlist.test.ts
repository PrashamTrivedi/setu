import { webcrypto } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { fingerprint, normalizeInputPreview } from './permission-allowlist.ts'

beforeAll(() => {
  const g = globalThis as unknown as { crypto?: Crypto }
  if (typeof g.crypto === 'undefined') {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
  }
})

describe('normalizeInputPreview', () => {
  it('lowercases and collapses whitespace', () => {
    expect(normalizeInputPreview('  Hello   World  ')).toBe('hello world')
  })

  it('strips ISO-8601 timestamps', () => {
    const a = normalizeInputPreview('Run at 2026-04-30T10:39:18Z')
    const b = normalizeInputPreview('Run at 2026-05-01T11:00:00.123Z')
    expect(a).toBe(b)
  })

  it('handles offset timestamps', () => {
    const a = normalizeInputPreview('cmd 2026-04-30T10:39:18+05:30 done')
    const b = normalizeInputPreview('cmd 2026-04-30T10:39:18-08:00 done')
    expect(a).toBe(b)
  })
})

describe('fingerprint', () => {
  it('is deterministic for identical inputs', async () => {
    const a = await fingerprint('Bash', 'ls -la')
    const b = await fingerprint('Bash', 'ls -la')
    expect(a).toBe(b)
  })

  it('matches across whitespace differences', async () => {
    const a = await fingerprint('Bash', 'ls   -la')
    const b = await fingerprint('Bash', '  LS -la ')
    expect(a).toBe(b)
  })

  it('matches across ISO-timestamp drift', async () => {
    const a = await fingerprint('Bash', 'echo 2026-04-30T10:39:18Z hello')
    const b = await fingerprint('Bash', 'echo 2026-05-01T03:14:15Z hello')
    expect(a).toBe(b)
  })

  it('differs when tool name differs', async () => {
    const a = await fingerprint('Bash', 'ls')
    const b = await fingerprint('Read', 'ls')
    expect(a).not.toBe(b)
  })

  it('differs when input differs', async () => {
    const a = await fingerprint('Bash', 'ls')
    const b = await fingerprint('Bash', 'rm -rf /')
    expect(a).not.toBe(b)
  })
})
