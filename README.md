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

```bash
bun install

# Worker — copy example then fill in your token
cp packages/worker/.dev.vars.example packages/worker/.dev.vars

# Bun supervisor — copy example then fill in worker URL, token, project paths
cp packages/bun-cli/.env.example packages/bun-cli/.env
```

## Local development

Run the worker in one terminal:

```bash
bun run dev
# wrangler dev — UI at http://localhost:8787
```

Run the Bun supervisor in another terminal (after editing `.env`):

```bash
cd packages/bun-cli
bun run start
```

Open `http://localhost:8787/?project=<your-project-id>` and create a card.
Click "spawn worker for branch" to launch a Claude session against the
configured project path.

## Scripts (root)

- `bun run dev` — wrangler dev (worker)
- `bun run typecheck` — TS project-references build (no emit)
- `bun run test` — vitest (no watch)
- `bun run test:watch` — vitest watch
- `bun run test:coverage` — vitest with coverage report
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
