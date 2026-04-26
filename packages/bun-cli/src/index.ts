#!/usr/bin/env bun
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ChannelEvent, ChannelToBun, WorkerToBun } from '@kanban/protocol'
import { BackChannelServer } from './back-channel.ts'
import { runCli } from './cli.ts'
import { loadConfig } from './config.ts'
import { SessionRegistry, sessionKey } from './sessions.ts'
import { type LocalStore, openStore } from './store.ts'
import { WorkerLink } from './worker-link.ts'
import { ensureWorktree } from './worktree.ts'

// ─── CLI dispatch ────────────────────────────────────────────────────────────
// `kanban-bun project add|list|rm` → run CLI and exit. Anything else (or
// no argv) → run the supervisor.
const argv = process.argv.slice(2)
const cliStore = openStore()
const cliResult = runCli(argv, cliStore)
if (cliResult.handled) {
  cliStore.close()
  process.exit(cliResult.exitCode)
}
// CLI did not handle this invocation — drop the temporary handle and continue
// into supervisor mode (which opens its own long-lived store).
cliStore.close()

// ─── Supervisor ──────────────────────────────────────────────────────────────
const cfg = loadConfig()
const store = openStore(cfg.dbPath)
const registry = new SessionRegistry(cfg)

const here = fileURLToPath(new URL('.', import.meta.url))
const channelEntry = (role: 'kanban-work' | 'kanban-ops'): string =>
  resolve(here, '..', '..', 'channels', role, 'src', 'index.ts')

const back = new BackChannelServer(cfg.socketPath, (key, msg) => onChannelMessage(key, msg))
back.start()

const link = new WorkerLink(cfg, (msg) => onWorkerMessage(msg))
link.setLiveSessionsProvider(() =>
  registry.list().map((s) => ({ project_id: s.project_id, branch: s.branch, role: s.role })),
)
link.setProjectsAvailableProvider(() => store.listProjects().map((p) => p.project_id))
link.start()

console.log(`[bun-cli] started — socket=${cfg.socketPath} machine=${cfg.machineId}`)
console.log(`[bun-cli] connecting to ${cfg.workerWs} …`)
{
  const known = store.listProjects()
  if (known.length === 0) {
    console.warn(
      '[bun-cli] no projects registered — add one with `kanban-bun project add <id> <path>`',
    )
  } else {
    console.log(
      `[bun-cli] ${known.length} project(s) registered: ${known.map((p) => p.project_id).join(', ')}`,
    )
  }
}

function projectPathFor(project_id: string, store: LocalStore): string | null {
  const row = store.getProject(project_id)
  return row?.project_path ?? null
}

// ─── Worker → Bun ────────────────────────────────────────────────────────────
async function onWorkerMessage(msg: WorkerToBun): Promise<void> {
  switch (msg.type) {
    case 'ensure_worktree': {
      const projectPath = projectPathFor(msg.project_id, store)
      if (!projectPath) {
        console.error(
          `[bun-cli] unknown project ${msg.project_id} — register with \`kanban-bun project add\``,
        )
        return
      }
      try {
        await ensureWorktree(projectPath, msg.branch, msg.source_branch)
      } catch (err) {
        console.error('[bun-cli] ensure_worktree failed', err)
      }
      return
    }
    case 'spawn_session': {
      const projectPath = projectPathFor(msg.project_id, store)
      if (!projectPath) {
        console.error(`[bun-cli] cannot spawn — unknown project ${msg.project_id}`)
        return
      }
      const cwd =
        msg.role === 'kanban-ops'
          ? projectPath
          : await ensureWorktree(projectPath, msg.branch).catch(() => projectPath)

      registry.spawn({
        project_id: msg.project_id,
        project_path: projectPath,
        branch: msg.branch,
        role: msg.role,
        cwd,
        initial_event: msg.initial_event,
        channelServerEntry: channelEntry(msg.role),
      })
      link.send({
        type: 'session_registered',
        project_id: msg.project_id,
        branch: msg.branch,
        role: msg.role,
      })
      if (msg.initial_event) waitAndDeliver(msg.project_id, msg.branch, msg.initial_event)
      return
    }
    case 'push_event': {
      back.send(sessionKey(msg.project_id, msg.branch), {
        type: 'channel_event',
        event: msg.channel_event,
      })
      return
    }
    case 'permission_verdict': {
      for (const s of registry.list()) {
        back.send(sessionKey(s.project_id, s.branch), {
          type: 'permission_verdict',
          request_id: msg.request_id,
          behavior: msg.behavior,
        })
      }
      return
    }
    case 'terminate_session': {
      registry.terminate(msg.project_id, msg.branch)
      link.send({
        type: 'session_terminated',
        project_id: msg.project_id,
        branch: msg.branch,
        reason: 'requested',
      })
      return
    }
  }
}

function waitAndDeliver(project_id: string, branch: string, event: ChannelEvent): void {
  const key = sessionKey(project_id, branch)
  const started = Date.now()
  const tick = () => {
    if (back.has(key)) {
      back.send(key, { type: 'channel_event', event })
      return
    }
    if (Date.now() - started > 10_000) {
      console.error('[bun-cli] timeout waiting for channel hello on', key)
      return
    }
    setTimeout(tick, 250)
  }
  tick()
}

// ─── Channel server → Bun ────────────────────────────────────────────────────
function onChannelMessage(key: string, msg: ChannelToBun): void {
  const [project_id, branch] = key.split('::') as [string, string]
  if (!registry.has(project_id, branch)) {
    console.warn('[bun-cli] dropped message — no session for', key)
    return
  }
  switch (msg.type) {
    case 'reply_tool_call':
      link.send({
        type: 'reply_tool_call',
        project_id,
        branch,
        tool_call_id: msg.tool_call_id,
        tool_name: msg.tool_name,
        args: msg.args,
      })
      return
    case 'permission_request':
      link.send({
        type: 'permission_request',
        project_id,
        branch,
        request_id: msg.request_id,
        tool_name: msg.tool_name,
        description: msg.description,
        input_preview: msg.input_preview,
      })
      return
  }
}

// ─── shutdown ────────────────────────────────────────────────────────────────
const shutdown = (sig: string) => {
  console.log(`[bun-cli] received ${sig}, shutting down`)
  link.stop()
  back.closeAll('shutdown')
  for (const s of registry.list()) registry.terminate(s.project_id, s.branch)
  store.close()
  process.exit(0)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
