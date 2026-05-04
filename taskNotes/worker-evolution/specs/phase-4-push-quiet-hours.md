# Phase 4 — Web push + quiet hours digest

## Purpose

Ping the user when they're away from the laptop. During quiet hours,
batch low-urgency events into a single digest sent at quiet-end.
Urgent events (`perm_ask`, `dispatch_kind:'asking'|'committing'`)
break through quiet hours.

## Scope

- `packages/worker/src/user-do.ts`
  - Storage:
    - `push_subs:<client_id>` — `PushSubscriptionJSON`.
    - `quiet_hours` — `{ from, to, tz } | null`.
    - `digest_queue:<project_id>` — `FeedItem[]`.
    - `quiet_alarm` — number; when to drain.
  - Handle `register_push { subscription }` and
    `set_quiet_hours { from, to, tz }`.
  - `notify(item)` — called on every `feed_item` broadcast:
    1. If urgent (rules above) → push immediately to all `push_subs`.
    2. Else if currently quiet → append to digest queue, schedule
       alarm at next quiet-end if not already.
    3. Else → single push.
  - `alarm()` — drain digest queues, send `digest` WS message per
    project, send a single push notification "N updates across X
    projects".
- `packages/worker/wrangler.jsonc`
  - `vars` for `VAPID_PUBLIC_KEY`; `secret` for `VAPID_PRIVATE_KEY`.
- VAPID push delivery — use `web-push` library if it works in
  Workers runtime; otherwise hand-roll the JWT + AES128GCM
  encryption (a few hundred lines but well-trodden). **Recommended
  spike before committing to one path.**

## Files touched

- `packages/worker/src/user-do.ts`
- `packages/worker/wrangler.jsonc`
- NEW `packages/worker/src/web-push.ts` (helper)

## Acceptance Criteria

- A real Chrome PushSubscription registered at deploy receives a
  notification when a `perm_ask` lands.
- During configured quiet hours, `dispatch_kind:'noting'` does NOT
  push; instead it lands in the digest at quiet-end.
- `dispatch_kind:'asking'` pushes immediately even during quiet.

## Validation

Manual end-to-end. Test cases:

1. Register a sub via Chrome devtools.
2. Trigger a noting dispatch — confirm no push.
3. Trigger an asking dispatch — confirm push.
4. Set quiet hours covering "now"; trigger noting; wait until
   quiet-end; confirm digest push.

## Risks / call-outs

- VAPID in Workers — confirm library compatibility. Cloudflare
  Workers do support `crypto.subtle`, so VAPID JWT signing is
  feasible; the AES128GCM payload encryption is the harder bit.
- Quiet-hours timezone arithmetic — use `Intl.DateTimeFormat` with
  the user's tz; persist as IANA strings.
- Rate limiting — Chrome and Mozilla's push servers throttle. For
  v1 (single user) it's fine; document the limit.
