# Kanban Channels

> Personal-deployment kanban orchestration for long-lived Claude Code
> sessions, built on Claude Code Channels (research preview) and Cloudflare
> Workers.

A reactive task-delivery system that pushes work into already-running Claude
Code sessions and supervises them through a kanban UI. Sessions persist
across cards; the cards flow through them.

This is **not** Vibe Kanban or langwatch's kanban-code — those tools spawn a
fresh Claude per card. This system spawns Claudes once per
`(project, branch)` and feeds them a stream of work via Claude Code Channels.

See [`docs/requirements.md`](docs/requirements.md) for the full design,
[`docs/architecture.md`](docs/architecture.md) for the diagram, and
[`docs/protocol.md`](docs/protocol.md) for wire shapes.

## Repository layout

```
packages/
  protocol/              # shared TS types: WS messages, domain, state machine
  worker/                # Cloudflare Worker + Durable Object + bundled UI
  bun-cli/               # local supervisor (long-lived Bun process)
  channels/
    _runtime/            # shared MCP + UDS plumbing
    kanban-work/         # long-lived channel — receives cards
    kanban-ops/          # ephemeral channel — finalize (merge, cleanup)
```

`@kanban/protocol` is the only package both `worker` and `bun-cli` import.
TypeScript project references enforce that `worker` and `bun-cli` cannot
import each other directly.

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.1
- A Cloudflare account (Workers + Durable Objects with SQLite — included in
  the free tier)
- Claude Code CLI on the supervising machine, with login set up
- An always-on host for the Bun supervisor (laptop, NUC, N100 — anything that
  stays awake)

## Generating shared secrets

The Worker and the Bun supervisor authenticate the WS link with a shared
bearer token. Generate it once:

```bash
openssl rand -hex 32
```

Put the value in:

- `packages/worker/.dev.vars` as `BUN_SHARED_TOKEN=…` (and as a Worker secret
  for production: `bunx wrangler secret put BUN_SHARED_TOKEN`)
- `packages/bun-cli/.env` as `KANBAN_BEARER_TOKEN=…` (must match)

## Setup

One command copies both example files (won't overwrite existing):

```bash
bun run setup:local
```

Then edit:

- `packages/worker/.dev.vars` — paste a freshly generated bearer token
- `packages/bun-cli/.env` — paste the **same** token

Generate the token with:

```bash
openssl rand -hex 32
```

Register your project on the Bun side (one-time, persisted in SQLite):

```bash
cd packages/bun-cli
bun run start project add demo /abs/path/to/your/repo
```

## Local development (wrangler dev on :9494)

Two terminals:

```bash
# terminal 1 — Cloudflare Worker (UI + API + DO)
bun run dev:worker
# → http://127.0.0.1:9494

# terminal 2 — Bun supervisor
bun run dev:bun
```

Or one terminal with both processes:

```bash
bun run dev:all
```

Then open `http://127.0.0.1:9494/?project=demo`, create a card, click
"spawn worker for branch". The supervisor's stdout will print
`[bun-cli] connecting to ws://localhost:9494/...`.

`wrangler dev` persists DO state to `.wrangler/state` by default, so cards
survive across dev restarts.

## Project storage

Project metadata (`display_name`, `default_branch`, `repo_policy`) lives in
the Worker's Durable Object (SQLite-backed). The Bun supervisor keeps the
machine-local `project_path` in its own SQLite store at
`$XDG_DATA_HOME/kanban-bun/state.db` (override with `KANBAN_DB_PATH`). Both
sides share a single DDL defined in `@kanban/protocol/schema.ts` — the
`projects` table has identical shape on both stores; only `project_path` is
populated on the Bun side.

Manage the local project list with the `kanban-bun` CLI:

```bash
cd packages/bun-cli

# add
bun run start project add demo /home/me/code/demo
bun run start project add sun /home/me/code/sunbloom --name "Sunbloom" --default-branch main

# list (id, repo_policy, default_branch, path)
bun run start project list

# remove
bun run start project rm demo
```

When the supervisor boots, it logs the registered projects and refuses to
spawn for any `project_id` it doesn't know about.

## Scripts (root)

- `bun run setup:local` — install deps + copy both `.env`/`.dev.vars` examples
- `bun run dev:worker` — wrangler dev on :9494 (worker only)
- `bun run dev:bun` — Bun supervisor (watch mode)
- `bun run dev:all` — both, side-by-side via concurrently
- `bun run typecheck` — `tsc -b` across all project references
- `bun run test` / `test:watch` / `test:coverage` — vitest
- `bun run lint` / `bun run lint:fix` — biome
- `bun run build` — build all packages

## Deploying the Worker

```bash
cd packages/worker
bunx wrangler secret put BUN_SHARED_TOKEN
bunx wrangler deploy
```

Note the `*.workers.dev` URL it prints — set it in your `bun-cli/.env` as
`KANBAN_WORKER_WS=wss://<that-host>/ws/bun/<project_id>`.

## v1 success criteria

See `docs/requirements.md` §14. Boiled down:

1. One card flows from creation → merged → archived without manual git from
   the user.
2. Approve is one click in the UI.
3. Bun survives a 30-second network blip without losing state.
4. A card created while session is offline is delivered on next live spawn.
5. A searchable archive entry lands in the Memory Server.

## Status

Pre-implementation scaffold. The state-machine logic is real; the worker and
supervisor compile; channels relay events end-to-end against a hand-fed
stream. Wire-up against a live Claude Code session is the next step.
