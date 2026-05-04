# Purpose

Evolve the Worker from "kanban CRUD + SSE poll" into a **push-based feed
broker** that fans dispatches and permission asks to mobile UI clients in
real time, while keeping the Bun↔Worker plumbing intact. Implementation is
phased so each phase ships and reverts cleanly.

## Original Ask

> Work on worker evolution per `docs/worker-redesign.md` — implement the
> 5-phase plan that evolves the Worker from kanban-CRUD + SSE polling into a
> push-based feed broker. Read `docs/worker-redesign.md`, `docs/protocol.md`,
> `docs/architecture.md`, and `docs/ui-mockup.html` for full context. The plan
> introduces UserDO (UI WS + push subs + quiet hours digest), grows ProjectDO
> with ephemeral feed + permission allowlist + committing-dispatch alarms,
> retires `__registry__` into UserDO, and creates a separate
> `@kanban/ui-protocol` package. Plan should phase the work; **Phase 1 should
> be implementable on its own**.

## Complexity and the reason behind it

**Score: 4/5.**

Reasoning:

- Multi-DO architecture changes (ProjectDO grows, UserDO is new, MachineDO
  gets a heartbeat snapshot) plus a fresh wire protocol package.
- DO alarms, WebSocket hibernation, web push (VAPID) are each non-trivial.
- Verification needs miniflare + DO-aware tests (the project's existing
  test surface is a placeholder smoke test) — verification cost is real.
- BUT each phase is independently shippable; Phase 1 is narrow enough to
  land without UI, push, or allowlist work. If we scoped just Phase 1
  alone the score would be 2/5.

## Architectural changes required

Yes — substantial. See `docs/worker-redesign.md` for the target picture.
Net-net by end of all phases:

- **NEW** `UserDO` singleton (named `__me__` for v1) — owns UI WebSocket
  fan-out, push subscriptions, quiet-hours digest, machine/project
  registry. Replaces today's `__registry__` ProjectDO singleton.
- **GROWN** `ProjectDO` — adds an ephemeral per-card feed, a permission
  allowlist, DO alarms for `committing` dispatches, a `ui_subs` map of
  hibernated WebSockets, and a `dispatch` handler in `applyReplyToolCall`.
- **GROWN** `MachineDO` — persists the latest `sessions_live` heartbeat
  snapshot and exposes a DO RPC so ProjectDO can resolve `to_role` peer
  routing for `peer_message` fan-out.
- **NEW** `@kanban/ui-protocol` package — UI↔Worker WebSocket message
  shapes (`UiToWorker`, `WorkerToUi`, `FeedItem`). Kept separate from
  `@kanban/protocol` so UI churn doesn't pollute the Bun↔Worker contract.

## Backend changes required

Phased — each phase is its own spec. See `specs/specs.md` for the full
breakdown and `specs/phase-N-*.md` for per-phase plans.

**Phase 1 — dispatch fan-out + feed primitive (immediate scope):**

- `packages/worker/src/project-do.ts`
  - Add `dispatch` case to `applyReplyToolCall`. Persist a `FeedItem`
    under storage key `feed:<card_id>:<seq>` (numeric seq for ordered
    range-list).
  - Append a project-wide index entry under `feed_index:<seq>` carrying
    `{ card_id, ts, kind }` so future phases can paginate the project
    feed without scanning per-card buckets.
  - On `kind === 'committing' && default_after_ms`: schedule a DO alarm
    for `now + default_after_ms` keyed by `(card_id, dispatch_id)`.
    Storage key `alarm:<dispatch_id>` records the payload.
  - `alarm()` handler: load all due alarms, mark feed item resolved,
    emit `input_response` if a paired `pending_input` exists on the
    card. Reschedule next-soonest alarm.
  - On `args.to_role`: query MachineDO for the live session matching
    `(project_id, branch, to_role)` (Phase 1.5 wires the snapshot — for
    Phase 1, do a best-effort lookup; if MachineDO doesn't yet have the
    snapshot endpoint, no-op the peer fan-out and log).
- `packages/protocol/src/messages.ts`
  - No wire-shape changes (already done in commit `569e397`). `dispatch`
    is in `ReplyToolName` and `peer_message` is in `ChannelEventKind`.
- `packages/worker/src/types.ts`
  - Internal `FeedItem` type shared between project-do and (later)
    user-do. Not exported from `@kanban/protocol`.

**Phase 1.5 — MachineDO sessions_live snapshot:**

- Persist `sessions_live` from `heartbeat` on MachineDO.
- New `GET /sessions_live` DO endpoint returning the latest snapshot.
- ProjectDO gains a `findPeerMachine(project_id, branch, role)` helper
  that walks the (single, for v1) machine and asks for the snapshot.

**Phase 2 — UI WebSocket + UserDO skeleton:**

- New `packages/worker/src/user-do.ts`. Singleton at `__me__`.
- `index.ts` routes `/ws/ui` → UserDO with bearer auth.
- New `@kanban/ui-protocol` package; UserDO depends on it.
- ProjectDO grows `ui_subs` (WS hibernation: `state.acceptWebSocket`)
  and emits `feed_item` to all subs on every dispatch / perm-ask /
  card_state change.
- Retire the `__registry__` ProjectDO singleton; UserDO owns the
  machine/project index. MachineDO `registerWithProjects` /
  `unregisterFromProjects` rewires to UserDO.
- Replace `/api/projects/:id/stream` SSE with WS. REST stays for card
  create/approve until Phase 4.

**Phase 3 — permission allowlist:**

- New ProjectDO storage `allowlist:<tool_name>:<scope>:<fingerprint>`.
- New `packages/worker/src/permission-allowlist.ts` with the
  fingerprint helper (normalize tool name + input_preview, hash).
- `applyPermissionRequest` (currently a v1.5 stub): fingerprint, look
  up, auto-allow on hit (sends `WorkerToBun.permission_verdict` via
  MachineDO). On miss, append `FeedItem { kind:'perm_ask' }` and
  broadcast.
- `UiToWorker.permission_verdict` carries `scope`; ProjectDO writes the
  allowlist row on `scope ≠ 'once'`.

**Phase 4 — web push + quiet hours:**

- UserDO accepts `register_push { subscription }` and stores VAPID
  subs. Wrangler binding for VAPID `PUBLIC_KEY` / `PRIVATE_KEY`.
- UserDO holds `quiet_hours { from, to, tz } | null`. On every
  `feed_item`:
  - `kind:'perm_ask'` or `dispatch_kind:'asking'|'committing'` →
    push immediately, regardless of quiet hours.
  - else if quiet → append to `digest_queue:<project_id>`.
  - else → single push.
- DO alarm at quiet-end → drain queue into `digest` WS messages and
  one push notification.

**Phase 5 — UI shell:**

- `packages/worker/src/ui.ts` swaps from kanban static page to a
  minimal SPA shell connecting to `/ws/ui`. Out of scope for this
  plan — tracked separately.

## Frontend changes required

Out of scope for this plan (Phase 5, separate doc). The only "frontend"
artifact in this codebase today is `packages/worker/src/ui.ts`, which is
left untouched until Phase 5.

## Acceptance Criteria

Per phase:

**Phase 1**
- Calling a `dispatch` reply tool from a Bun-mocked inbound message
  results in a stored `FeedItem` under `feed:<card_id>:<seq>` in
  ProjectDO storage, retrievable via a (test-only) helper.
- A `committing` dispatch with `default_after_ms` schedules a DO alarm,
  and on alarm fire the feed item is marked resolved.
- If `pending_input` is set on the card when the alarm fires and a
  paired `dispatch_id` is recorded, `push_event` of kind
  `input_response` is dispatched via MachineDO.
- `to_role` peer fan-out either succeeds (snapshot present) or no-ops
  cleanly without throwing.
- `bun run --cwd packages/worker test` passes.
- `bun run typecheck` passes for the workspace.

**Phase 1.5**
- MachineDO persists `sessions_live` and serves it on `/sessions_live`.
- ProjectDO peer-lookup returns the right `machine_id` for a known
  `(project_id, branch, role)` triple.

**Phase 2**
- A test client can WS-connect to `/ws/ui` with the bearer, send
  `hello`, `subscribe { project_ids }`, and receive `feed_item`
  broadcasts on ProjectDO state changes.
- Hibernation works: a DO that has only WS subs can be evicted and
  resumed without the client noticing (tested via miniflare time-skip).
- `__registry__` paths are removed; project listing in UI flows through
  UserDO.

**Phase 3**
- Repeated permission_request with the same fingerprint and a stored
  `branch`/`forever` allow short-circuits — UI sees no `perm_ask`
  feed item and Bun receives a `permission_verdict { allow }`.
- `scope: 'once'` does NOT persist an allowlist row.

**Phase 4**
- A registered VAPID sub receives a push when a `perm_ask` lands, even
  inside quiet hours.
- During quiet hours, low-urgency `feed_item`s queue into a digest and
  fire as a single push at quiet-end.

## Validation

For each phase, validation is a mix of unit-level DO tests
(miniflare or hand-stubbed `DurableObjectState`) and a manual
end-to-end smoke once a UI exists.

**Phase 1 validation (most relevant — immediate scope):**

Unit tests in `packages/worker/src/project-do.test.ts` (new file):

```bash
bun run --cwd packages/worker test
```

Cases:

1. `dispatch` with `kind: 'noting'` — stored FeedItem, no alarm.
2. `dispatch` with `kind: 'committing'` + `default_after_ms: 50` —
   alarm scheduled, stored FeedItem with `committing.deadline` set.
3. Time-skip past deadline — alarm fires, feed item marked
   `committing.resolved = true`.
4. Same as (3) but with `pending_input` on the card — `push_event` of
   kind `input_response` dispatched (verify via mocked MachineDO stub).
5. `dispatch` with `to_role: 'kanban-work'` and no peer snapshot — no
   throw, no peer event.
6. Dedupe — repeated `tool_call_id` is ignored (existing
   `seenToolCalls` set).

Type checking:

```bash
bun run typecheck
```

Manual smoke (deferred until Phase 2 lands UI):

```bash
# from a paired Bun supervisor, force a kanban-ops dispatch:
# → confirm worker logs show feed item stored
wrangler tail
```

**Phase 2 validation:** WS round-trip test using `@cloudflare/vitest-pool-workers`
once it's wired in. Until then, manual via `wscat` and `wrangler dev`.

**Phase 3 validation:** unit tests on the fingerprint helper plus a DO
test that exercises hit/miss paths.

**Phase 4 validation:** end-to-end with a real browser PushSubscription
in dev (Chrome → Cloudflare Workers dev push endpoint).

---

## Specs

This task is split per phase. See:

- [specs/specs.md](specs/specs.md) — overview and dependency graph
- [specs/phase-1-dispatch-feed.md](specs/phase-1-dispatch-feed.md) — **immediate scope**
- [specs/phase-1_5-sessions-snapshot.md](specs/phase-1_5-sessions-snapshot.md)
- [specs/phase-2-userdo-ws.md](specs/phase-2-userdo-ws.md)
- [specs/phase-3-permission-allowlist.md](specs/phase-3-permission-allowlist.md)
- [specs/phase-4-push-quiet-hours.md](specs/phase-4-push-quiet-hours.md)
