#!/usr/bin/env bun
import type { ChannelEvent, ChannelToBun, WorkerToBun } from '@kanban/protocol'
import { BackChannelServer } from './back-channel.ts'
import { runCli } from './cli.ts'
import { loadEnvFile, resolveConfigPath } from './config-file.ts'
import { loadConfig } from './config.ts'
import { SessionRegistry, sessionKey } from './sessions.ts'
import { type LocalStore, openStore } from './store.ts'
import { WorkerLink } from './worker-link.ts'
import { ensureWorktree } from './worktree.ts'

// Auto-load .env from the canonical config location *before* anything reads
// process.env. Existing shell vars take precedence (loadEnvFile is no-overwrite).
const configPath = resolveConfigPath()
if (configPath) loadEnvFile(configPath)

// ─── CLI dispatch ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const cliStore = openStore()
const cliResult = runCli(argv, cliStore, console.log, configPath ?? undefined)
if (cliResult.handled) {
  cliStore.close()
  process.exit(cliResult.exitCode)
}
if (!cliResult.runSupervisor) {
  // Defensive: shouldn't happen given current cli.ts, but bail safely.
  cliStore.close()
  console.error('unknown invocation; run `setu help`')
  process.exit(2)
}
cliStore.close()

// ─── Supervisor ──────────────────────────────────────────────────────────────
function bootConfig() {
  try {
    return loadConfig()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[setu] ${msg}`)
    console.error(
      configPath
        ? `[setu] config file: ${configPath} — fill in the missing variable there`
        : '[setu] no config file found. Create ~/.config/setu/.env (see `setu help`)',
    )
    process.exit(1)
  }
}
const cfg = bootConfig()
const store = openStore(cfg.dbPath)
const registry = new SessionRegistry(cfg)

const back = new BackChannelServer(cfg.socketPath, (key, msg) => onChannelMessage(key, msg))
back.start()

const link = new WorkerLink(cfg, (msg) => onWorkerMessage(msg))
link.setLiveSessionsProvider(() =>
  registry.list().map((s) => ({ project_id: s.project_id, branch: s.branch, role: s.role })),
)
link.setProjectsAvailableProvider(() => store.listProjects().map((p) => p.project_id))
link.start()

{
  const u = new URL(cfg.workerWs)
  u.pathname = `/ws/bun/${cfg.machineId}`
  console.log(`[setu] started — socket=${cfg.socketPath} machine=${cfg.machineId}`)
  console.log(`[setu] config=${configPath ?? '(none — using shell env)'}`)
  console.log(`[setu] connecting to ${u.toString()} …`)
}
{
  const known = store.listProjects()
  if (known.length === 0) {
    console.warn('[setu] no projects registered — add one with `setu project add <id> <path>`')
  } else {
    console.log(
      `[setu] ${known.length} project(s) registered: ${known.map((p) => p.project_id).join(', ')}`,
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
          `[setu] unknown project ${msg.project_id} — register with \`setu project add\``,
        )
        return
      }
      try {
        await ensureWorktree(projectPath, msg.branch, msg.source_branch)
      } catch (err) {
        console.error('[setu] ensure_worktree failed', err)
      }
      return
    }
    case 'spawn_session': {
      const projectPath = projectPathFor(msg.project_id, store)
      if (!projectPath) {
        console.error(`[setu] cannot spawn — unknown project ${msg.project_id}`)
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
      const key = sessionKey(msg.project_id, msg.branch)
      if (back.has(key)) {
        back.send(key, { type: 'channel_event', event: msg.channel_event })
        return
      }
      // No live channel server — auto-respawn unless we already kicked off
      // a respawn for this key in the last RESPAWN_COOLDOWN_MS. The cooldown
      // catches the case where the user fires several messages in a row
      // before Claude has booted; without it we'd spin up a tmux window per
      // message.
      if (recentRespawn(key)) {
        waitAndDeliver(msg.project_id, msg.branch, msg.channel_event)
        return
      }
      const role = msg.channel_event.meta.role
      const projectPath = projectPathFor(msg.project_id, store)
      if (!projectPath) {
        console.error(`[setu] push_event for unknown project ${msg.project_id}`)
        return
      }
      console.warn(
        `[setu] no live channel for ${key} — respawning ${role} to deliver ${msg.channel_event.meta.event_kind}`,
      )
      const cwd =
        role === 'kanban-ops'
          ? projectPath
          : await ensureWorktree(projectPath, msg.branch).catch(() => projectPath)
      try {
        registry.spawn({
          project_id: msg.project_id,
          project_path: projectPath,
          branch: msg.branch,
          role,
          cwd,
        })
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err)
        console.error(`[setu] respawn failed for ${key}: ${m}`)
        return
      }
      markRespawn(key)
      link.send({
        type: 'session_registered',
        project_id: msg.project_id,
        branch: msg.branch,
        role,
      })
      waitAndDeliver(msg.project_id, msg.branch, msg.channel_event)
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

// Per-key cooldown so a burst of push_events after a supervisor restart
// doesn't spawn a tmux window per message while the first Claude is booting.
const RESPAWN_COOLDOWN_MS = 12_000
const respawnAt = new Map<string, number>()
function recentRespawn(key: string): boolean {
  const at = respawnAt.get(key)
  if (!at) return false
  if (Date.now() - at > RESPAWN_COOLDOWN_MS) {
    respawnAt.delete(key)
    return false
  }
  return true
}
function markRespawn(key: string): void {
  respawnAt.set(key, Date.now())
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
      console.error('[setu] timeout waiting for channel hello on', key)
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
    console.warn('[setu] dropped message — no session for', key)
    return
  }
  switch (msg.type) {
    case 'reply_tool_call':
      console.log(
        `[setu] reply_tool_call ${msg.tool_name} from ${project_id}/${branch} (call=${msg.tool_call_id.slice(0, 8)})`,
      )
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
      console.log(
        `[setu] permission_request ${msg.tool_name} from ${project_id}/${branch} (req=${msg.request_id})`,
      )
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
  console.log(`[setu] received ${sig}, shutting down`)
  link.stop()
  back.closeAll('shutdown')
  for (const s of registry.list()) registry.terminate(s.project_id, s.branch)
  store.close()
  process.exit(0)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
