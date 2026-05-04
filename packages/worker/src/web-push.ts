/**
 * Minimal Web Push (RFC 8030 + VAPID RFC 8292) helper for Cloudflare Workers.
 *
 * Phase 4 scope. The VAPID JWT path is functional (ECDSA-P256 via WebCrypto).
 * The encrypted-payload path (RFC 8291 aes128gcm) is intentionally a TODO —
 * for v1 we ship payload-less pushes; the SW wakes the client and the UI
 * fetches real content over the existing WS. That avoids reimplementing
 * AES128GCM HKDF in this file.
 *
 * `VAPID_PRIVATE_KEY` MUST be a JWK string (ECDSA P-256, `d`/`x`/`y`).
 * Generate with:
 *
 *   const kp = await crypto.subtle.generateKey(
 *     { name:'ECDSA', namedCurve:'P-256' }, true, ['sign','verify']
 *   )
 *   const priv = await crypto.subtle.exportKey('jwk', kp.privateKey)
 *   const pub  = await crypto.subtle.exportKey('raw', kp.publicKey)
 *
 * `VAPID_PUBLIC_KEY` is `pub` base64url-encoded (uncompressed 65 bytes).
 */

import type { PushSubscriptionJSON } from '@kanban/ui-protocol'

export interface VapidConfig {
  /** base64url-encoded uncompressed P-256 public key (65 bytes). */
  publicKey: string
  /** ECDSA P-256 private key as a JWK JSON string. */
  privateKey: string
  /** mailto: or https: URL identifying the push sender. */
  subject: string
}

export interface PushSendResult {
  ok: boolean
  status: number
  statusText: string
  endpoint: string
}

export async function sendPush(
  subscription: PushSubscriptionJSON,
  vapid: VapidConfig,
  ttlSeconds = 60,
): Promise<PushSendResult> {
  const audience = new URL(subscription.endpoint).origin
  const jwt = await buildVapidJwt(audience, vapid)
  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      authorization: `vapid t=${jwt}, k=${vapid.publicKey}`,
      ttl: String(ttlSeconds),
      'content-length': '0',
    },
  })
  return {
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    endpoint: subscription.endpoint,
  }
}

async function buildVapidJwt(audience: string, vapid: VapidConfig): Promise<string> {
  const header = { typ: 'JWT', alg: 'ES256' }
  const now = Math.floor(Date.now() / 1000)
  const claims = { aud: audience, exp: now + 60 * 60 * 12, sub: vapid.subject }
  const headerB64 = b64url(new TextEncoder().encode(JSON.stringify(header)))
  const claimsB64 = b64url(new TextEncoder().encode(JSON.stringify(claims)))
  const signingInput = `${headerB64}.${claimsB64}`

  const jwk = JSON.parse(vapid.privateKey) as JsonWebKey
  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )
  const sigBuf = await crypto.subtle.sign(
    { name: 'ECDSA', hash: { name: 'SHA-256' } },
    key,
    new TextEncoder().encode(signingInput),
  )
  return `${signingInput}.${b64url(new Uint8Array(sigBuf))}`
}

function b64url(buf: Uint8Array): string {
  let s = ''
  for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i] ?? 0)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
