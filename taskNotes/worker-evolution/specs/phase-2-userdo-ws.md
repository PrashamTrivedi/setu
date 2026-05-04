# Phase 2 — UserDO + UI WebSocket + retire `__registry__`

## Purpose

Stand up the UI broker. UserDO singleton owns one WebSocket per
connected client, manages subscriptions to ProjectDOs, and replaces
the `__registry__` ProjectDO singleton as the source of truth for
the machine/project index.

## Scope

- **NEW package** `packages/ui-protocol/`
  - `src/index.ts`, `src/messages.ts` — `UiToWorker`, `WorkerToUi`,
    `FeedItem` shapes (per `docs/worker-redesign.md` "Wire" section).
  - `package.json` with name `@kanban/ui-protocol`, exporting types.
  - `tsconfig.json` mirroring `@kanban/protocol`.
- **NEW** `packages/worker/src/user-do.ts` — singleton `__me__`.
  - `/__ws/ui` accepts WS with bearer (`UI_BEARER` secret).
  - On `subscribe { project_ids }`: call ProjectDO `/_ui_sub` to add
    `client_id`. ProjectDO uses `state.acceptWebSocket(server)` for
    hibernation. (UserDO ↔ ProjectDO actually relay messages — UserDO
    holds the user-facing WS; ProjectDO calls back into UserDO on each
    feed_item via DO RPC. Hibernation only applies if we move the WS
    onto ProjectDO. **Decision:** UserDO holds the WS for fan-out
    simplicity; ProjectDO calls UserDO `/broadcast` per feed_item. We
    revisit hibernation when WS counts grow.)
  - Storage:
    - `machines:<machine_id>` — replaces `__registry__`'s entries.
    - `subs:<client_id>` — `{ project_ids: string[] }`.
    - `quiet_hours` — Phase 4.
    - `push_subs:<client_id>` — Phase 4.
- `packages/worker/src/index.ts` — route `/ws/ui` → UserDO.
- `packages/worker/src/machine-do.ts`
  - `registerWithProjects` / `unregisterFromProjects` write to
    UserDO `/machines/upsert` and `/machines/down` instead of
    ProjectDO `__registry__`.
- `packages/worker/src/project-do.ts`
  - **Remove** `handleRegistry` and `_registry/*` paths.
  - On every feed write (Phase 1), additionally call UserDO
    `/broadcast` so subscribed clients receive `feed_item`.
- `packages/worker/wrangler.jsonc` — bind `USER_DO`.

## Files touched

- NEW `packages/ui-protocol/{src,package.json,tsconfig.json}`
- NEW `packages/worker/src/user-do.ts`
- `packages/worker/src/index.ts`
- `packages/worker/src/machine-do.ts`
- `packages/worker/src/project-do.ts`
- `packages/worker/wrangler.jsonc`
- `package.json` (workspaces) if new package needs registration.

## Acceptance Criteria

- `wscat -c ws://localhost:9494/ws/ui -H "Authorization: Bearer …"`
  → send `hello` → receive `welcome`.
- Subscribe to a project → trigger a `dispatch` via Bun → receive
  `feed_item` over WS.
- `__registry__` ProjectDO instance is gone; UserDO `GET /machines`
  returns the list.

## Validation

Manual via `wrangler dev` + `wscat`. Add automated coverage when
`@cloudflare/vitest-pool-workers` lands (currently a placeholder per
`packages/worker/src/index.test.ts:1-12`).

## Risks / call-outs

- WS hibernation: deferred to a Phase 2.5 follow-up if needed. The
  v1 user count is 1; a single live WS in UserDO is fine.
- `UI_BEARER`: needs `wrangler secret put UI_BEARER` at deploy time;
  add to README env section.
- The `__registry__` retirement is a **breaking** internal change. No
  consumer outside the worker package depends on it directly, but
  `packages/bun-cli` may have a `/api/registry/list` consumer — audit
  before merging.
