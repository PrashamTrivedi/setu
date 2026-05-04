# Phase 1 — dispatch fan-out + feed primitive

## Purpose

Land the `dispatch` reply tool end-to-end inside the Worker: persist the
authored card-level feed, schedule alarms for `committing` dispatches, and
fan peer messages into the receiver session. No UI yet — verified entirely
through DO-level tests with MachineDO mocked.

## Scope

- `packages/worker/src/project-do.ts`
  - Add `dispatch` case to `applyReplyToolCall`.
  - Introduce in-DO storage:
    - `feed_seq` — number, monotonic.
    - `feed:<card_id>:<seq>` — `FeedItem`.
    - `feed_index:<seq>` — `{ card_id, ts, kind }`.
    - `alarm:<dispatch_id>` — `{ card_id, dispatch_id, deadline,
      tool_call_id }`.
    - `alarm_next` — number; the soonest scheduled deadline.
  - On dispatch:
    1. Allocate `seq = ++feed_seq`, `dispatch_id = crypto.randomUUID()`.
    2. Build `FeedItem { kind:'dispatch', id, ts:Date.now(), card_id,
       from_role: msg.role-or-derive, dispatch_kind, body, to_role,
       committing? }`. Note: `from_role` derivation — the inbound
       `reply_tool_call` carries `project_id` + `branch`; ProjectDO needs
       the originating session's role. Today the wire doesn't include the
       role on a `reply_tool_call`. **Decision:** add `role` to
       `BunToWorker.reply_tool_call` (small, additive change to
       `@kanban/protocol`). Default to `'kanban-work'` if missing for
       backward compat with older Bun supervisors.
    3. Persist `feed:<card_id>:<seq>` and `feed_index:<seq>`.
    4. Evict oldest if per-card count > 200 (storage `list({ prefix:
       'feed:<card_id>:' , limit:1, reverse:false })` to find oldest).
    5. If `kind === 'committing'` and `default_after_ms`, persist
       `alarm:<dispatch_id>` and call
       `state.storage.setAlarm(deadline)` only if no earlier alarm
       exists (i.e. update `alarm_next`).
    6. If `to_role` set: query MachineDO peer snapshot (Phase 1.5).
       If snapshot endpoint not yet present (HTTP 404), no-op and log.
       If a matching session exists, dispatch `push_event` with
       `event_kind: 'peer_message'` and meta `{ from_role,
       dispatch_kind }`.
- `packages/worker/src/project-do.ts` — new `alarm()` method.
  - Walk `alarm:*` keys, fire any with `deadline <= now`.
  - For each fired:
    - Load the `FeedItem` and set `committing.resolved = true`.
    - If the card has `pending_input` AND the alarm payload references a
      paired tool_call_id, send `push_event` of `event_kind:
      'input_response'` to MachineDO; clear `pending_input`.
    - Delete `alarm:<dispatch_id>` and the entry.
  - Recompute `alarm_next` from remaining alarms and call
    `setAlarm(next)` if any remain.
- `packages/protocol/src/messages.ts`
  - Add optional `role: SessionRole` to `BunToWorker.reply_tool_call`.
  - Bump `PROTOCOL_VERSION` to 3 (history comment).
- `packages/worker/src/types.ts`
  - Internal `FeedItem` type matching the shape from the redesign doc.
  - Internal `AlarmRecord` type.
- `packages/bun-cli/src/worker-link.ts` (assumed location of the
  Bun→Worker WS) — **DEFERRED**. Phase 1 is purely Worker-side; the
  optional `role` field will be populated by Bun in a follow-up. Tests
  exercise the path where `role` is present.

## Out of scope for Phase 1

- UserDO and `/ws/ui`. The feed is stored but no client subscribes to it.
- Allowlist. `permission_request` continues to no-op as today.
- Push notifications.
- UI shell.

## Files touched

- `packages/worker/src/project-do.ts` — bulk of changes.
- `packages/worker/src/types.ts` — `FeedItem`, `AlarmRecord`.
- `packages/worker/src/project-do.test.ts` — NEW; unit tests via
  hand-stubbed `DurableObjectState` (seven test cases below).
- `packages/protocol/src/messages.ts` — optional `role` field.
- `packages/protocol/src/version.ts` — `PROTOCOL_VERSION = 3`.

## Test cases

In `packages/worker/src/project-do.test.ts` (uses a fake
`DurableObjectState` that backs `storage` with a `Map`):

1. `dispatch { kind:'noting' }` — feed item stored, no alarm scheduled.
2. `dispatch { kind:'committing', default_after_ms: 50 }` — feed item has
   `committing.deadline`, alarm scheduled.
3. Time-skip by simulating `alarm()` call — feed item updated to
   `committing.resolved = true`.
4. Same as (3) with `card.pending_input` set and the alarm record
   carrying a `paired_tool_call_id` — MachineDO mock receives a
   `push_event { event_kind:'input_response' }`.
5. `dispatch { to_role:'kanban-work' }` with MachineDO snapshot endpoint
   returning 404 — no throw, no peer dispatch.
6. `dispatch { to_role:'kanban-work' }` with MachineDO snapshot
   returning a live session — peer `push_event` sent with meta
   `{ from_role, dispatch_kind, event_kind:'peer_message' }`.
7. Repeated `tool_call_id` — second call is dropped by existing
   `seenToolCalls` set; no duplicate FeedItem.

## Acceptance Criteria

- All 7 test cases pass.
- `bun run typecheck` passes.
- `bun run --cwd packages/protocol test` still passes.
- No regression in `packages/worker/src/index.test.ts`.
- Existing `update_card`, `request_input`, `report_progress`,
  `report_step` paths unchanged.

## Validation

```bash
# from repo root
bun install                            # ensure deps fresh
bun run --cwd packages/protocol test   # protocol unaffected
bun run --cwd packages/worker test     # NEW project-do test file
bun run typecheck                      # whole workspace
```

Manual smoke (only meaningful with a paired Bun supervisor):

```bash
# 1. wrangler dev in one terminal
bun run --cwd packages/worker dev

# 2. trigger a dispatch from a kanban-ops session
#    → confirm in `wrangler tail` that feed item is logged
```

A more thorough end-to-end smoke is gated on Phase 2's UI and is not
required to merge Phase 1.

## Risks / call-outs

- **Adding `role` to `reply_tool_call`** is the only wire-protocol
  change. Optional + backward-compatible (older Bun ⇒ default
  `'kanban-work'`). Bumping `PROTOCOL_VERSION` to 3 is the right
  signal.
- **Feed eviction at 200** — the `storage.list` is bounded by per-card
  prefix so cost is fine. Worth a comment explaining the policy.
- **`alarm_next` accounting** — Cloudflare DO has a single alarm slot.
  Always set to the soonest deadline; on fire, recompute from
  remaining records. Be careful never to drop an alarm record without
  also rescheduling.
- **`peer_message` requires Phase 1.5 to be useful.** Phase 1 ships the
  call site behind a graceful 404 fallback; effective peer fan-out
  arrives with Phase 1.5.
