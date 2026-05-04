# Worker Evolution — Specs Overview

The worker-redesign rolls out in five phases. Each is independently
shippable and has its own taskFindings file.

## Dependency graph

```
Phase 1 (dispatch feed)        ← can ship alone
   │
   ├── Phase 1.5 (sessions snapshot)   ← unblocks peer fan-out
   │
   └── Phase 2 (UserDO + UI WS)        ← needs feed broadcasts to be useful
            │
            ├── Phase 3 (permission allowlist)
            └── Phase 4 (push + quiet hours)

Phase 5 (UI shell) — separate workstream, not covered here.
```

## Phase summaries

| Phase | File | What lands |
|-------|------|------------|
| 1 | [phase-1-dispatch-feed.md](phase-1-dispatch-feed.md) | `dispatch` handler in ProjectDO; ephemeral feed; committing-dispatch DO alarm |
| 1.5 | [phase-1_5-sessions-snapshot.md](phase-1_5-sessions-snapshot.md) | MachineDO persists `sessions_live`; ProjectDO peer-lookup |
| 2 | [phase-2-userdo-ws.md](phase-2-userdo-ws.md) | UserDO + `/ws/ui`; hibernated `ui_subs` on ProjectDO; retire `__registry__` |
| 3 | [phase-3-permission-allowlist.md](phase-3-permission-allowlist.md) | Allowlist with branch/forever scopes; auto-allow on hit |
| 4 | [phase-4-push-quiet-hours.md](phase-4-push-quiet-hours.md) | VAPID push subs; quiet-hours digest; alarm-driven drain |

## Implementation order

Recommended: 1 → 1.5 → 2 → 3 → 4.

Phase 1 and 1.5 can be merged into one PR if the team wants peer fan-out
working from day one. Phase 2 is the biggest single PR — the UserDO and
hibernation work is meaningful.

## Cross-cutting decisions

These apply across phases:

- **Feed cap.** Per-card feed bounded at 200 items, oldest evicted.
  Project-wide index bounded at 1000 entries. Drop both on archive.
  (Open Q #1 in the redesign doc — start with cap, not without.)
- **Monotonic seq per project.** ProjectDO holds a `feed_seq` counter
  in storage. Every FeedItem gets `seq = ++feed_seq` and that's the
  paging cursor for `replay { since }`. (Open Q #2.)
- **`committing` with no paired `request_input`.** Alarm still fires
  and resolves the feed item; no `input_response` is sent. UI
  shows the resolution as cosmetic. (Open Q #3.)
- **Allowlist fingerprinting.** `fingerprint = sha256(tool_name + ':' +
  normalize(input_preview))`. `normalize` = trim, lowercase, collapse
  whitespace, strip ISO-8601 timestamps. Strict equality after
  normalize. (Open Q #4.)
- **UI bearer.** New wrangler secret `UI_BEARER`. UserDO stores it on
  first `/__set_ui_bearer` ping at deploy time. (Open Q #5.)
- **Card REST stays on ProjectDO.** UserDO is purely a UI broker.
  (Open Q #6.)
