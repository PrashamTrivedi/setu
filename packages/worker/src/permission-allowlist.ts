/**
 * Permission allowlist primitives.
 *
 * The allowlist lets the user say "always allow this exact ask" so subsequent
 * matching `permission_request`s short-circuit to `allow` without bothering the
 * UI. Match is on a normalized fingerprint of `tool_name + input_preview`.
 *
 * Storage layout (inside ProjectDO):
 *   allow:forever:<fingerprint>           = { tool_name, granted_at }
 *   allow:branch:<fingerprint>:<branch>   = { tool_name, granted_at }
 */

const ISO_TIMESTAMP_RE =
  /\b\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g

/** Conservative normalization. Strict equality after this transform. */
export function normalizeInputPreview(input: string): string {
  return input.replace(ISO_TIMESTAMP_RE, '<ts>').toLowerCase().replace(/\s+/g, ' ').trim()
}

/** Hex sha256 over `tool_name + ':' + normalized(input_preview)`. */
export async function fingerprint(toolName: string, inputPreview: string): Promise<string> {
  const norm = normalizeInputPreview(inputPreview)
  const data = new TextEncoder().encode(`${toolName}:${norm}`)
  const buf = await crypto.subtle.digest('SHA-256', data)
  const bytes = new Uint8Array(buf)
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] ?? 0
    out += b.toString(16).padStart(2, '0')
  }
  return out
}

export interface AllowlistRow {
  tool_name: string
  granted_at: number
}

export function foreverKey(fp: string): string {
  return `allow:forever:${fp}`
}

export function branchKey(fp: string, branch: string): string {
  return `allow:branch:${fp}:${branch}`
}
