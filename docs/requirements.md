# Kanban Channels — Requirements

> Personal-deployment kanban orchestration for long-lived Claude Code sessions, built on Claude Code Channels (research preview) and Cloudflare Workers.

**Author:** Prasham H Trivedi
**Status:** v1 design, pre-implementation
**Audience:** Self; possibly others self-hosting their own Bun supervisor against their own Worker.

---

## 1. Purpose

A reactive task-delivery system that pushes work into already-running Claude Code sessions and supervises them through a kanban UI. The sessions persist across cards; the cards flow through them.

This is **not** Vibe Kanban or langwatch's kanban-code. Those tools spawn a fresh Claude per card. This system spawns Claudes once per `(project, branch)` and feeds them a stream of work via Claude Code Channels. Different model, different unit of parallelism, complementary rather than competing.

## 2. Goals

- Remote-controlled supervision of Claude Code sessions running on a local always-on machine.
- Kanban-style task delivery: cards created in a UI flow into running sessions as channel events.
- Bidirectional: Claude can report status, request synchronous human input, and surface tool-permission prompts to the UI.
- Clean privilege separation. Worker has no machine rights; Bun has no git rights; only Claude does real work.
- Survivability: WS reconnection without process restarts, queueing across disconnects.
- Single-operator system. No multi-tenant concerns, no public surface.

## 3. Non-goals

- Public SaaS or multi-tenant deployment.
- Replacement for spawn-per-card kanban tools. The two patterns coexist.
- Chat-platform bridges (Telegram, Discord, iMessage). The Worker UI is the only surface.
- General-purpose agent orchestration framework. Scope is bounded to one operator's Claude Code sessions.

## 4. Architecture

Three components, three responsibilities, no overlap:

```
[Browser/UI]  ←→  [Worker + DO]  ←─ WS ─→  [Bun supervisor]  ←─ stdio ─→  [Claude Code child]
                                                                                  ↓
                                                                         [git, fs, network]
```

- **Worker** (Cloudflare Worker + Durable Object + bundled UI) — kanban brain. Holds card state, drives the lifecycle state machine, exposes UI. Owns no machine authority.
- **Bun supervisor** (local long-lived process) — process supervisor with a network adapter. Maintains WS to Worker, spawns Claude Code children with the right `cwd` and channel registration, multiplexes their stdio onto the single WS.
- **Claude Code sessions** — the only component with real authority. Per-spawn scope set by `cwd` and channel `instructions`. All git, filesystem, and network work happens here.

## 5. Components

### 5.1 Worker

- Cloudflare Worker hosting both API and bundled UI.
- One Durable Object per `project_id`. DO holds card list, per-`(project_id, branch)` event queue, session liveness, in-flight permission requests.
- Single WS endpoint per Bun supervisor (keyed by `machine_id`).
- Auth: bearer token issued at first pairing; signed messages on the WS for tamper resistance.

### 5.2 Bun supervisor

- Long-lived parent process started manually (v1) or via launchd/systemd unit (later).
- Maintains one WS to Worker. Reconnects on drop without restarting children.
- Heartbeat reports `(machine_id, available_project_paths, live_sessions)`.
- Spawns Claude Code children on Worker request. Each child:
  - `cwd` set explicitly per spawn (no process-wide chdir).
  - MCP channel registered with `meta.project_id`, `meta.branch`, `meta.role`.
  - stdio multiplexed back to Worker via the single WS.
- Routes Worker → child events by `(project_id, branch)`. Routes child → Worker reply tool calls and permission requests.
- **No git logic.** Bun ensures worktrees exist on request (because that's filesystem ops, not repo semantics) but does not run merge, push, or branch-delete.

### 5.3 Claude Code children

Two roles, both bidirectional Claude Code channels (per [channels-reference](https://code.claude.com/docs/en/channels-reference)):

- **kanban-work** — long-lived, one per `(project_id, branch)`. Receives cards as channel events. Reply tool exposes `update_card`, `request_input`, `report_progress`.
- **kanban-ops** — short-lived, ephemeral. Spawned for finalize operations (merge, worktree cleanup, branch deletion). `cwd` is the main repo, not the worktree. Reply tool exposes `report_step`. Tightly scoped instructions to prevent scope creep into feature work.

Both channels declare `claude/channel/permission` capability for permission relay (v1.5+).

#### 5.3.1 Channel implementation contract

Each channel is a stdio MCP server (Bun runtime) that Claude Code spawns as a subprocess. Bun does *not* implement the channel itself — Bun spawns Claude with `--dangerously-load-development-channels server:kanban-work` (or `kanban-ops`), and Claude in turn spawns the channel server. The channel server's stdio is owned by Claude; the channel server talks to Bun out-of-band over the WS-multiplexed back-channel.

Server capabilities declared at startup:

```ts
capabilities: {
  experimental: {
    'claude/channel': {},
    'claude/channel/permission': {},  // v1.5
  },
  tools: {},  // for the reply tool surface
}
```

Inbound card events are emitted as MCP notifications:

```ts
await mcp.notification({
  method: 'notifications/claude/channel',
  params: {
    content: card.description,
    meta: {
      project_id, branch, card_id,
      role: 'kanban-work',          // or 'kanban-ops'
      event_kind: 'card' | 'input_response' | 'cancel_advisory'
    }
  }
})
```

Claude sees them as `<channel source="kanban-work" project_id="..." branch="..." card_id="..." event_kind="card">…</channel>`. The `source` attribute is fixed by the channel name; all `meta` keys become tag attributes and are how Claude routes its reply.

Reply tools (declared via `ListTools` / `CallTool`):

| Channel | Tool | Args | Effect |
|---|---|---|---|
| kanban-work | `update_card` | `card_id, status, evidence?` | Worker advances card state machine |
| kanban-work | `request_input` | `card_id, prompt` | Blocks card; UI shows prompt; answer arrives as `input_response` event |
| kanban-work | `report_progress` | `card_id, note` | Append-only progress log on card |
| kanban-ops | `report_step` | `card_id, step, status, detail?` | Drives `merging → merged → cleaning → archived` |

Each tool call is wrapped by the channel server into a `reply_tool_call` WS message (§6.1) with a `tool_call_id` so the Worker can dedupe on reconnect.

#### 5.3.2 Sender gating

Cards are not user-typed text — they pass through the Worker DO, which is the trust boundary. The channel server still validates that every inbound notification carries a `meta.project_id` matching the channel's spawn args, and rejects mismatches. This prevents a Worker bug or misrouted message from delivering a different project's card into this Claude.

#### 5.3.3 Distribution

Channel servers live in `packages/channels/{kanban-work,kanban-ops}` inside the monorepo. During development they're loaded with `--dangerously-load-development-channels`. v1 does not package as a marketplace plugin — the system is single-operator and the dev flag is the supported path. Future packaging as a private plugin is additive and does not change the contract above.

## 6. Protocol

A shared `@kanban/protocol` package defines all message types. Both Worker and Bun import from it; neither imports from the other.

### 6.1 Bun → Worker (WS)

- `hello` — `{machine_id, projects_available[], protocol_version}`
- `heartbeat` — `{timestamp, sessions_live[]}`
- `session_registered` — `{project_id, branch, role}`
- `session_terminated` — `{project_id, branch, reason}`
- `reply_tool_call` — `{project_id, branch, tool_call_id, tool_name, args}`
- `permission_request` — `{project_id, branch, request_id, tool_name, description, input_preview}`

### 6.2 Worker → Bun (WS)

- `spawn_session` — `{project_id, project_path, branch, role, initial_event?}`
- `terminate_session` — `{project_id, branch}`
- `push_event` — `{project_id, branch, channel_event}`
- `permission_verdict` — `{request_id, behavior}`
- `ensure_worktree` — `{project_id, branch, source_branch?}` (Bun creates via `git worktree add`)

### 6.3 Channel server ↔ Claude (stdio, MCP standard)

Standard MCP channel surface as defined by [channels-reference](https://code.claude.com/docs/en/channels-reference). No custom extensions.

- **Inbound (channel → Claude):** `notifications/claude/channel` with `params.content` and `params.meta`. `meta` keys surface as `<channel>` tag attributes.
- **Reply (Claude → channel):** standard MCP `tools/call` against the channel's declared tools (§5.3.1). Channel server forwards to Bun as `reply_tool_call`.
- **Permission relay (v1.5):** inbound `notifications/claude/channel/permission_request` carrying a 5-letter `request_id` (no `l`); outbound verdict via `notifications/claude/channel/permission` with `behavior: 'allow' | 'deny'`. Channel server bridges these to the Worker as `permission_request` / `permission_verdict` (§6.1, §6.2). First verdict wins between local TUI and Worker UI.

### 6.4 Channel server ↔ Bun (back-channel)

The channel server's stdio belongs to Claude, so it cannot speak to Bun on stdio. Bun exposes a Unix domain socket at a well-known path (`$XDG_RUNTIME_DIR/setu.sock`); each spawned channel server connects on startup and identifies itself with the `(project_id, branch, role)` it was spawned for. All inbound events and outbound `reply_tool_call` / `permission_request` messages flow over this socket. The socket is single-machine, single-user; no auth needed beyond filesystem permissions on the socket path.

### 6.5 UI ↔ Worker

REST for card CRUD and lifecycle actions; WS or SSE from DO for live state updates.

## 7. Data model

### 7.1 Card

```
id, project_id, title, description, target_branch,
status, created_at, updated_at,
evidence[], merge_strategy, repo_policy,
finalize_steps[]?  // populated during finalize
```

Status state machine:

```
backlog → assigned → in_progress
       → done-pending-review
       → approved
       → merging → merged
       → cleaning → archived

Failure substates: merge_failed, clean_failed (manual retry from UI)
```

### 7.2 Project

```
project_id (slug), display_name, project_path,
default_branch, repo_policy: own | client
```

`repo_policy` controls finalize default. `own` projects merge to `default_branch` directly. `client` projects open a PR instead. v1 may hard-code `own` and defer `client` to v1.5.

### 7.3 Session

- Routing key: `(project_id, branch)`.
- States:
  - `offline` — Bun parent has no WS to Worker.
  - `standby` — Bun connected, no Claude child for this `(project_id, branch)`.
  - `live` — Bun connected AND Claude child running AND channel handshake completed.
- Queue drains only on `live`. WS up alone is not readiness.

## 8. Lifecycle

### 8.1 Happy path

1. User creates card in UI. Worker stores, `status=backlog`.
2. User clicks "spawn worker for `{branch}`" in UI. Worker sends `ensure_worktree` then `spawn_session` to Bun.
3. Bun creates worktree if absent, spawns Claude child with `cwd` set, channel registered. Worker marks session `live`.
4. Worker drains queue: oldest backlog card for `(project_id, branch)` pushed as channel event. `status=in_progress`.
5. Claude works. May call `request_input` reply tool. Worker shows prompt in UI. User answers. Worker pushes answer back as channel event. Claude unblocks and continues.
6. Claude calls `update_card` with `status=done`. Worker flips card to `done-pending-review`.
7. User reviews evidence, clicks Approve. `status=approved`.
8. Worker sends `spawn_session` for `role=finalize` with `cwd=main_repo_path`. Bun spawns ephemeral Claude with kanban-ops channel.
9. Finalize Claude receives task description, runs git ops, reports each step via `report_step`. Worker advances `merging → merged → cleaning`.
10. On clean completion, Worker writes archive memory to Memory Server, sets `status=archived`. Card disappears from active board.

### 8.2 Permission relay (v1.5)

1. Claude calls a tool needing approval. Local terminal dialog opens. Channel notification fires to Bun.
2. Bun forwards `permission_request` to Worker over WS.
3. Worker UI shows prompt with Allow/Deny, including `description`, `input_preview`, and the originating card.
4. User clicks Allow. Worker sends `permission_verdict` to Bun. Bun emits verdict notification to Claude.
5. Whichever path (terminal or remote) answers first wins. The other dialog closes.

### 8.3 Failure handling

- WS drop: Bun buffers outbound messages, replays on reconnect. Worker dedupes by `tool_call_id`.
- Bun crash: all children die. Worker marks all sessions `offline`. UI shows clearly. User restarts Bun manually (v1) or via launchd unit (later). Cards in `in_progress` remain so until session re-spawned.
- Merge failure: `status=merge_failed`, error stored on card, retry button in UI re-spawns finalize Claude.
- Clean failure: same pattern, separate retry. Branch may already be merged at this point.

## 9. Privilege model

| Component | Authority | Trust basis |
|---|---|---|
| Worker | None on any machine | Safe to expose publicly with auth |
| Bun | Spawn processes on local machine | Local-only, trusted by virtue of running on user's machine |
| Claude Code | Full Claude Code authority | Scoped per-spawn by `cwd` and `instructions` |

Worker compromise = attacker can ask Bun to spawn Claudes; Claude's instructions and (v1.5) permission relay catch destructive intent. Bun compromise = local machine compromise, already game over for unrelated reasons. Claude doing something stupid = same risk profile as any direct Claude Code session.

## 10. Repository structure

Monorepo, Bun workspaces:

```
kanban-channels/
  packages/
    protocol/       # shared types, message schemas, version constant
    worker/         # Cloudflare Worker (API, DO, UI bundled)
    bun-cli/        # local supervisor
    channels/
      kanban-work/  # stdio MCP channel server, long-lived role
      kanban-ops/   # stdio MCP channel server, finalize role
  package.json      # workspaces declaration
  bun.lockb
  README.md
  docs/
    requirements.md  # this file
    architecture.md
    protocol.md
```

`protocol` is the only package both `worker` and `bun-cli` import. tsconfig project references enforce that `worker` and `bun-cli` cannot import from each other directly. If split into separate repos becomes necessary later, the workspace boundary is already where the cut would happen.

## 11. v1 scope

**In scope:**

- Single project, single branch, single card flowing end-to-end.
- Manual session spawn from UI (no auto-spawn on enqueue).
- Worktree creation on session spawn (drain-time, not enqueue-time).
- Reply tool surface: `update_card`, `request_input`, `report_progress`, `report_step`.
- Worker DO state machine: backlog → archived, with merge/clean failure states.
- Finalize Claude does git work; Bun does not.
- WS reconnection without restart on either side.
- Three session states correctly enforced (`live` requires channel handshake, not just WS).
- Memory Server archive write on `archived` transition.

**Deferred (v1.5+):**

- Multi-card queueing per `(project_id, branch)`.
- Auto-spawn session when a card is created for a non-live branch.
- Permission relay UI surface.
- Cancellation primitive (advisory channel event for v1, hard SIGINT later).
- Multi-machine (laptop + N100 simultaneously, machine selection per project).
- Client repo PR-flow finalize variant.
- Worktree orphan UI panel with one-click cleanup.
- Signed messages on WS, bearer token rotation.

**Out of scope (any version):**

- Telegram, Discord, iMessage bridges.
- Public multi-tenant deployment.
- Subscription sharing of Claude Code (system requires user's own Claude Code login).

## 12. Integration points

- **Memory Server** (existing — Cloudflare D1 + KV) — archived cards written as memories tagged `consultancy-war/kanban/archived/{project}/{card_id}` with original prompt, branch, merge SHA, evidence URLs, Claude's done-report. Six-month-later searchability comes free.
- **Parakh** (future) — Parakh test results POST to a Worker webhook endpoint, attached as evidence on the corresponding card.
- **Cloudflare Workers Analytics Engine** — kanban metrics (cards created, time-to-done, time-to-merge, finalize failure rate). Same pattern already used elsewhere in the stack.

## 13. Risks and constraints

- **Channels are research preview**, claude.ai login only, no API key support. Worker can only push events into sessions that a human started. The system requires *some* live session to do anything.
- **Always-on session host required.** Laptop closed = system idle. N100 plan is the steady-state unblocker.
- **MCP child crash = card stuck.** v1 does not auto-recover in-flight cards; user manually re-spawns and the queue redelivers.
- **Worktree contention.** Two finalize Claudes operating on the same main repo's git metadata simultaneously is unsafe. DO must serialize finalize spawns per `project_id`.
- **WS reconnection in-flight tool calls.** Outbound messages must be buffered with `tool_call_id` for idempotent replay; Worker dedupes on receive.

## 14. Success criteria for v1

- One Sunnbloom card flows from creation through merged-and-archived without manual git intervention from the user.
- Approve action is one click in the UI; no terminal interaction required for finalize.
- Bun process survives a 30-second network blip and reconnects without losing state.
- A card created while session is offline is correctly delivered when session next becomes live.
- Memory Server contains a searchable archive entry for the completed card.

If those five hold, v1 is done. Everything in §11 deferred is additive scope on a working spine.