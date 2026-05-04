# Phase 1.5 — sessions_live snapshot on MachineDO

## Purpose

Make `to_role` peer fan-out actually route. ProjectDO needs to ask
"is there a live `kanban-work` session for `(project_id, branch)`?"
and find the right `machine_id`. Phase 1 left a graceful no-op here.

## Scope

- `packages/worker/src/machine-do.ts`
  - On `case 'heartbeat'`: persist `state.storage.put('sessions_live',
    msg.sessions_live)` plus a `last_heartbeat_ts`.
  - New `GET /sessions_live` returns
    `{ sessions: SessionLiveSummary[], last_heartbeat_ts }`.
- `packages/worker/src/project-do.ts`
  - New helper `findPeerMachine(project_id, branch, role) →
    Promise<string | null>`.
  - For v1 single-machine deployments: read from the paired machine
    only (the one stored at `machine_id` for this ProjectDO).
  - Multi-machine future: query the UserDO registry once Phase 2
    introduces it.

## Files touched

- `packages/worker/src/machine-do.ts`
- `packages/worker/src/project-do.ts`
- `packages/worker/src/project-do.test.ts` — extend Phase 1 case (5)
  to flip from 404 to 200 and assert peer dispatch.

## Acceptance Criteria

- A heartbeat with `sessions_live: [{project_id:'p1', branch:'b1',
  role:'kanban-work'}]` results in `GET /sessions_live` on MachineDO
  returning that array.
- ProjectDO `findPeerMachine` returns the paired `machine_id` when a
  matching session exists; `null` otherwise.

## Validation

```bash
bun run --cwd packages/worker test
```

## Risks / call-outs

- Multi-machine routing: deferred. For v1 there's exactly one Bun
  supervisor per UserDO so the simple "check the paired machine"
  works. Once Phase 2's UserDO holds the machine list we revisit.
- Storage churn: every heartbeat writes the snapshot. Acceptable —
  heartbeat cadence is low (seconds), and the payload is a few
  hundred bytes. No need for a write coalescer in v1.
