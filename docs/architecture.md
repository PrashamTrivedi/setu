# Architecture

A reactive task-delivery system that pushes work into already-running Claude
Code sessions and supervises them through a kanban UI.

## Component diagram

```
┌─────────────┐    HTTPS / SSE    ┌──────────────────────────┐
│  Browser    │ ◄────────────────►│  Cloudflare Worker + DO  │
│  (kanban UI)│                   │  - card state machine    │
└─────────────┘                   │  - per-project DO        │
                                  │  - bundled UI            │
                                  └──────────┬───────────────┘
                                             │ WSS (bearer)
                                             │
                                  ┌──────────▼───────────────┐
                                  │   Bun supervisor          │
                                  │   - reconnects, buffers   │
                                  │   - spawns Claude         │
                                  │   - UDS back-channel      │
                                  │   - ensure_worktree only  │
                                  └──────────┬───────────────┘
                                             │ stdio
                                  ┌──────────▼───────────────┐
                                  │   Claude Code child       │
                                  │   ┌────────────────────┐  │
                                  │   │ stdio MCP channel  │  │
                                  │   │ (kanban-work or    │  │
                                  │   │  kanban-ops)       │  │
                                  │   └─────────┬──────────┘  │
                                  └─────────────┼─────────────┘
                                                │ Unix domain socket
                                                ▼
                                       (back to Bun supervisor)
```

## Privilege boundaries

| Layer        | Authority                       | Trust basis                         |
| ------------ | ------------------------------- | ----------------------------------- |
| Worker       | None on any machine             | Safe to expose publicly with bearer |
| Bun          | Spawn processes; FS only        | Local-only, user's machine          |
| Claude child | Full Claude Code tool surface   | Scoped per-spawn by `cwd`           |
| Channel MCP  | None — pure plumbing            | Stdio owned by Claude               |

Bun has **no git semantics** — it can `git worktree add` because that is a
filesystem op the supervisor must own to spawn the child correctly. Merge,
push, branch deletion, and any other repo-mutating operation runs only inside
a kanban-ops Claude.

## Session states

`offline → standby → live`. The drain queue only runs against `live`, which
requires both the WS to be up and the channel's back-channel hello to have
arrived. WS-up alone is not readiness — see §7.3 of `requirements.md`.
