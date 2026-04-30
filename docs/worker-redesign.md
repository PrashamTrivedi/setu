# Worker re-design — toward dispatches

Target: shift the Worker from a "kanban CRUD + SSE poll" service into a
**push-based feed broker** that fans dispatches and permission asks to
mobile UI clients in real time, while keeping the Bun↔Worker plumbing
intact.

This plan is incremental; each phase ships on its own and reverts cleanly
if abandoned.

---

## Goals

1. Carry the new `dispatch` reply tool end-to-end (Bun → Worker → UI, plus
   peer fan-out into the receiver session).
2. Replace SSE-tick polling with a **WebSocket push** to UI clients.
3. Hold a **permission allowlist** so "always allow for this branch"
   short-circuits future requests without UI roundtrip — Claude side stays
   plain `allow|deny`.
4. Hold an **ephemeral structured feed** per card. No long-term transcript
   persistence; gone on archive.
5. Wire up **web push** (VAPID) so the user gets pinged when away from
   the laptop, with a quiet-hours digest mode.
6. Multi-project unified feed: one subscription, all your projects.

## Non-goals

- Raw Claude reasoning capture (separate workstream — Bun-side stdio
  wrapping or session JSON tail).
- Full user auth/authorization (single-user-per-deployment for v1; bearer
  token issued at setup).
- UI framework choice — this plan covers the Worker contract only.

---

## Architecture target

### DO topology

```
UserDO        (NEW — singleton at name '__me__' for the v1 single-user case)
 │
 │ ─── machines: { machine_id, last_seen, projects[] }
 │ ─── projects: { project_id, display_name, last_active_at }
 │ ─── ui_clients: { client_id, ws, subscribed_projects[], device_meta }
 │ ─── push_subs: { client_id, vapid_endpoint, keys, … }
 │ ─── quiet_hours: { from, to, tz } | null
 │ ─── digest_queue: FeedItem[]   (filled while quiet, drained at quiet end)
 │
 ├──────────────────┐
 │                  │
 ↓                  ↓
ProjectDO         MachineDO    (existing — unchanged on the wire)
 │
 ├── cards:         { card_id, status, evidence, … }       (existing, kept)
 ├── feed:          FeedItem[] keyed by card                (NEW, ephemeral)
 ├── pending_perms: { request_id → PermissionRequest }      (NEW)
 ├── allowlist:     { (tool_name, fingerprint, scope) → }   (NEW)
 ├── ui_subs:       { client_id → ws }                      (NEW, WS hibernate)
 └── alarms:        committing-dispatch timers              (NEW)
```

The `__registry__` ProjectDO singleton is **retired** — its job moves to
`UserDO`.

### Data flow (dispatch)

```
Claude (kanban-ops) calls dispatch({ to_role:'kanban-work', kind:'noting', body:'…' })
  → channel-server forwards as reply_tool_call
  → Bun → MachineDO → ProjectDO.applyReplyToolCall

ProjectDO:
  1. Append FeedItem { kind:'dispatch', from_role, dispatch_kind, body, … }
     to the card's feed (and a project-wide index).
  2. Broadcast to local ui_subs WS.
  3. Notify UserDO so it can fan out to other UI clients subscribed to
     this project (cross-device) and trigger push if the user is silent.
  4. If args.to_role is set:
       - look up the live session (project_id, branch, to_role) via the
         heartbeat snapshot we already get (sessions_live).
       - send push_event with event_kind:'peer_message', meta.from_role,
         meta.dispatch_kind via MachineDO → Bun → channel-server.
  5. If kind === 'committing' and default_after_ms:
       - schedule DO alarm for now + default_after_ms, key by
         (card_id, dispatch_id).
       - on fire: if a paired request_input is awaiting, push input_response
         "auto-accepted (committing window expired)" back to the agent;
         mark dispatch resolved in the feed and rebroadcast.
```

### Data flow (permission with scope)

```
Claude needs tool → channel-server emits permission_request →
  Bun → MachineDO → ProjectDO.

ProjectDO:
  1. fingerprint = hash(tool_name + normalized(input_preview))
  2. Lookup allowlist[(tool_name, fingerprint, branch)] :
       - hit  → immediately reply permission_verdict { allow } via MachineDO.
       - miss → store in pending_perms, append FeedItem { kind:'perm_ask' },
                broadcast to ui_subs, trigger push (if allowed by quiet hours).

UI replies via WS: { type:'permission_verdict', request_id, behavior, scope }
  scope ∈ { 'once', 'branch', 'forever' }.

ProjectDO:
  - If allow + scope ≠ 'once': persist allowlist row keyed by scope.
       'branch'  → key includes branch
       'forever' → key omits branch
  - Always: send permission_verdict { behavior:'allow'|'deny' } to MachineDO
            (Worker compresses scope; channel wire stays binary).
  - Remove pending entry; broadcast feed update.
```

---

## Wire — new UI ↔ Worker protocol

Lives in a **new `@kanban/ui-protocol` package** (kept separate from
`@kanban/protocol` so the Bun↔Worker contract isn't polluted by UI
shape churn).

### Client → Server

```ts
type UiToWorker =
  | { type: 'hello'; client_id: string; bearer: string }
  | { type: 'subscribe'; project_ids: string[] }
  | { type: 'replay'; project_id: string; since?: number }   // FeedItems since ts
  | { type: 'permission_verdict'; request_id: string;
      behavior: 'allow' | 'deny'; scope: PermissionScope }
  | { type: 'redirect'; card_id: string; body: string }       // → input_response
  | { type: 'spawn_card'; card_id: string }                   // existing action
  | { type: 'register_push'; subscription: PushSubscriptionJSON }
  | { type: 'set_quiet_hours'; from: string; to: string; tz: string }
  | { type: 'pong'; ts: number }
```

### Server → Client

```ts
type WorkerToUi =
  | { type: 'welcome'; me: UserSummary }
  | { type: 'feed_item'; project_id: string; item: FeedItem }
  | { type: 'feed_replay'; project_id: string; items: FeedItem[] }
  | { type: 'project_state'; project_id: string; cards: CardSummary[];
      pending_perms: PermissionRequest[] }
  | { type: 'fleet'; sessions_live: SessionLiveSummary[];
      machines: MachineSummary[] }
  | { type: 'digest'; project_id: string; items: FeedItem[] }   // sent at quiet-end
  | { type: 'ping'; ts: number }

type FeedItem =
  | { id: string; ts: number; kind: 'dispatch';
      card_id: string; from_role: SessionRole;
      dispatch_kind: DispatchKind; body: string;
      to_role?: SessionRole;
      committing?: { default_after_ms: number; deadline: number; resolved?: boolean } }
  | { id: string; ts: number; kind: 'perm_ask';
      card_id: string; request_id: string;
      tool_name: string; description: string; input_preview: string;
      resolved?: { behavior: 'allow' | 'deny'; scope: PermissionScope; at: number } }
  | { id: string; ts: number; kind: 'card_state';
      card_id: string; from: CardStatus; to: CardStatus }
  | { id: string; ts: number; kind: 'peer_in';
      card_id: string; from_role: SessionRole; body: string }
```

Transport: WebSocket at `/ws/ui` (DO route forwards to UserDO, which
holds the connection and fans out subscriptions to ProjectDOs).

---

## Phased migration

### Phase 1 — dispatch fan-out + feed primitive
*(tight, lands the protocol v2 changes already drafted)*

- ProjectDO: handle `tool_name === 'dispatch'` in `applyReplyToolCall`
  - Append `FeedItem { kind:'dispatch' }` to in-DO state under
    `feed:<card_id>` (Map keyed by ts so we can range-list).
  - If `to_role` set, look up `sessions_live` (need to thread it in via
    MachineDO heartbeat — see Phase 1.5) and emit `push_event` with
    `event_kind:'peer_message'`.
- ProjectDO: schedule DO alarm for `kind:'committing' + default_after_ms`.
  Alarm handler resolves the dispatch and (if a paired `pending_input`
  exists on the card) emits `input_response` to Bun.
- No UI yet — write tests with MachineDO mocked.

### Phase 1.5 — sessions_live snapshot
- MachineDO already accepts `heartbeat { sessions_live }`. Persist the
  latest snapshot on the MachineDO so ProjectDO can query "is there a
  kanban-work session for (project_id, branch)?" via DO RPC. Needed to
  resolve `to_role` peer routing.

### Phase 2 — UI WebSocket + UserDO skeleton
- Add UserDO with WS endpoint at `/ws/ui` (per-client `client_id` from
  setup-time bearer; v1 has one user, so UserDO is a singleton).
- UserDO subscribes/unsubscribes against ProjectDOs; ProjectDO maintains
  `ui_subs: Map<client_id, WebSocket>` using **WebSocket hibernation**
  (`state.acceptWebSocket`) so DOs can sleep cheaply between events.
- ProjectDO broadcasts `feed_item` on every dispatch / perm-ask /
  card_state change. UI receives via UserDO relay.
- Replace `/api/projects/:id/stream` SSE with the WS. Keep REST for
  card create/approve until Phase 4.
- Drop `__registry__` ProjectDO; UserDO owns the machine/project index.

### Phase 3 — permission allowlist
- New ProjectDO storage: `allowlist:<tool_name>:<scope>:<fingerprint>`.
- `applyPermissionRequest`: fingerprint and look up before broadcasting
  to UI; auto-allow on hit.
- New `UiToWorker.permission_verdict` carries `scope`; ProjectDO writes
  the allowlist row on `scope ≠ 'once'`.
- `MachineDO → ProjectDO` already passes `permission_request` inbound;
  what's missing is the *outbound* allow path — add a
  `WorkerToBun.permission_verdict` send via MachineDO. (Type already
  exists in `@kanban/protocol`; we just don't emit it today.)

### Phase 4 — web push + quiet hours
- UserDO accepts `register_push { subscription }` and stores VAPID subs.
- UserDO holds `quiet_hours { from, to, tz }`; on `feed_item` notify:
  - if `kind:'perm_ask'` or `dispatch_kind:'asking'|'committing'`: send
    push immediately, regardless of quiet hours.
  - else if quiet: append to `digest_queue:<project_id>`.
  - else: send a single push.
- DO alarm fires at quiet-end → drain queue into one `digest` message
  per project + one push notification.

### Phase 5 — UI shell
- `ui.ts` swaps from the kanban static page to a tiny SPA shell that
  loads the dispatch feed (the mockup design). Out of scope for this
  doc; tracked separately.

---

## Files touched per phase

| Phase | Files |
|------|------|
| 1    | `packages/worker/src/project-do.ts` (dispatch handler, feed, alarm), `packages/worker/src/index.test.ts` (extend) |
| 1.5  | `packages/worker/src/machine-do.ts` (persist heartbeat snapshot, expose `/sessions_live`), `project-do.ts` (peer lookup) |
| 2    | NEW `packages/worker/src/user-do.ts`, `index.ts` (route `/ws/ui`), retire `__registry__` paths in `project-do.ts` |
| 3    | `project-do.ts` (allowlist, fingerprint helper), NEW `packages/worker/src/permission-allowlist.ts` |
| 4    | `user-do.ts` (push, quiet hours, digest), wrangler binding for VAPID secrets |
| 5    | `packages/worker/src/ui.ts` → SPA shell |

---

## Open questions

1. **Feed cap & eviction.** Per-card feed should bound at e.g. 200 items
   (oldest evicted) so a long-running card doesn't blow DO storage.
   On archive, drop the feed entirely. OK to start with no cap and add
   one when we see real volume?

2. **Cross-device replay.** When a user opens the phone after dropping
   the laptop, the WS reconnects with `replay { since }`. We need a
   monotonic ts-or-seq per project so replay is deterministic. Lean
   toward seq number per ProjectDO (cheap).

3. **`committing` semantics if no `request_input` is paired.** Spec
   says "auto-resolves as accepted on timeout." If there's nothing
   to push back to the agent, the timer is purely UI-cosmetic
   (turns the card from amber → grey). Probably fine, but worth
   confirming with first real use.

4. **Allowlist fingerprinting.** `input_preview` is free-form. Need a
   normalization step (trim/lower/strip volatile bits like timestamps
   in commands). Start conservative — strict equality of a normalized
   form — and loosen only if we see false-misses in practice.

5. **Single-user auth for v1.** `BUN_SHARED_TOKEN` is already a secret;
   issue a separate `UI_BEARER` at deploy time and stash in UserDO.
   Multi-user is out of scope.

6. **Should ProjectDO still own card REST?** Considered moving card
   create/approve into UserDO so the entire UI surface is one DO.
   Argues against: ProjectDO is already the source of truth for card
   state. Keep REST there; UserDO is purely the UI broker.
