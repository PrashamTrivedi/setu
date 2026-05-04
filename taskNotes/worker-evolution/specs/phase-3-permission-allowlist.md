# Phase 3 — Permission allowlist

## Purpose

"Always allow for this branch" — short-circuit repeated permission
asks without a UI roundtrip, while keeping the Claude-side channel
surface plain `allow|deny`.

## Scope

- **NEW** `packages/worker/src/permission-allowlist.ts`
  - `fingerprint(tool_name, input_preview): string` — sha256 of
    `tool_name + ':' + normalize(input_preview)`. `normalize` =
    trim, lowercase, collapse whitespace, strip ISO-8601
    timestamps. Pure function, unit-tested.
- `packages/worker/src/project-do.ts`
  - New storage scheme:
    - `allow:<scope>:<fingerprint>` — `1` (or branch in value when
      scope='branch').
  - `applyPermissionRequest(msg)` (today: stub):
    1. Compute `fp = fingerprint(tool_name, input_preview)`.
    2. Check `allow:forever:<fp>` → if hit, send
       `WorkerToBun.permission_verdict { allow }` via MachineDO and
       return.
    3. Check `allow:branch:<fp>` whose stored branch matches the
       request's branch → if hit, allow and return.
    4. Miss: append `FeedItem { kind:'perm_ask' }` and broadcast
       (Phase 2 path); store `pending_perms:<request_id>`.
  - New inbound from UserDO (`/_ui_verdict`):
    - `{ request_id, behavior, scope }`. Send the verdict to Bun.
      Persist `allow:<scope>:<fp>` if `scope ≠ 'once'`. Update the
      feed item's `resolved` field and broadcast.
- `packages/ui-protocol/src/messages.ts` — `permission_verdict`
  message in `UiToWorker` carries `scope`.
- `packages/worker/src/user-do.ts` — relay
  `permission_verdict` from UI WS to the right ProjectDO.

## Files touched

- NEW `packages/worker/src/permission-allowlist.ts`
- `packages/worker/src/project-do.ts`
- `packages/worker/src/user-do.ts`
- `packages/ui-protocol/src/messages.ts`

## Test cases

In `packages/worker/src/permission-allowlist.test.ts`:

1. Same `tool_name` + same `input_preview` → same fingerprint.
2. Whitespace differences → same fingerprint after normalize.
3. ISO-8601 timestamp variation → same fingerprint after strip.

In `packages/worker/src/project-do.test.ts`:

4. First `permission_request` → feed item appended, no auto-allow.
5. UI replies `{ scope:'branch', behavior:'allow' }` → allowlist row
   stored under that branch.
6. Second identical `permission_request` (same branch) → auto-allow,
   no feed item, MachineDO mock receives `permission_verdict`.
7. Same fingerprint, different branch → still asks.
8. `scope:'forever'` → branch-agnostic auto-allow.
9. `scope:'once'` → no allowlist row written.

## Acceptance Criteria

All 9 tests pass; existing tests still pass.

## Validation

```bash
bun run --cwd packages/worker test
```

## Risks / call-outs

- **Fingerprint normalization** is the most likely false-miss source.
  Start strict (after normalize) and loosen if real-world preview
  shapes show drift.
- **Scope semantics:** `branch` keys include the request's branch in
  the stored row's value, not the storage key. The lookup checks
  `value.branch === request.branch`. This avoids a fingerprint
  explosion across branches at the cost of one extra read.
