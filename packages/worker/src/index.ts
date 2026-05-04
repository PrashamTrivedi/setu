/// <reference types="@cloudflare/workers-types" />
import { Hono } from 'hono'
import type { Env } from './types.ts'
import { indexHtml } from './ui.ts'

export { ProjectDO } from './project-do.ts'
export { MachineDO } from './machine-do.ts'
export { UserDO } from './user-do.ts'

const app = new Hono<{ Bindings: Env }>()

// ─── UI ────────────────────────────────────────────────────────────────────
app.get('/', (c) => c.html(indexHtml))

// ─── Card CRUD + lifecycle (proxies to ProjectDO) ──────────────────────────
app.all('/api/projects/:projectId/cards', forwardToProject('/cards'))
app.all('/api/projects/:projectId/cards/:cardId/:action{approve|spawn|input}', (c) => {
  const { cardId, action } = c.req.param()
  return forwardToProject(`/cards/${cardId}/${action}`)(c)
})

// ─── Registry: list known projects + machines (now via UserDO) ─────────────
app.get('/api/projects', (c) => {
  return userStub(c.env).fetch('https://internal/projects')
})

app.get('/api/projects/:projectId/status', forwardToProject('/status'))

// ─── UI WebSocket (Phase 2) ───────────────────────────────────────────────
app.get('/ws/ui', (c) => {
  return userStub(c.env).fetch(rewritten(c.req.raw, '/__ws/ui'))
})

// ─── Bun supervisor WS endpoint (machine-keyed) ───────────────────────────
app.get('/ws/bun/:machineId', async (c) => {
  const machineId = c.req.param('machineId')
  if (!machineId) return c.text('machine_id required', 400)
  const id = c.env.MACHINE_DO.idFromName(machineId)
  const stub = c.env.MACHINE_DO.get(id)
  await stub
    .fetch('https://internal/__set_machine_id', {
      method: 'POST',
      body: JSON.stringify({ machine_id: machineId }),
      headers: { 'content-type': 'application/json' },
    })
    .catch(() => {})
  return stub.fetch('https://internal/__ws/bun', c.req.raw)
})

// ─── Helpers ───────────────────────────────────────────────────────────────
function projectStub(env: Env, projectId: string) {
  const id = env.PROJECT_DO.idFromName(projectId)
  return env.PROJECT_DO.get(id)
}

function userStub(env: Env) {
  const id = env.USER_DO.idFromName('__me__')
  return env.USER_DO.get(id)
}

function forwardToProject(path: string) {
  return async (c: { req: { raw: Request; param: (k: string) => string }; env: Env }) => {
    const stub = projectStub(c.env, c.req.param('projectId'))
    const url = new URL(c.req.raw.url)
    const init: RequestInit = {
      method: c.req.raw.method,
      headers: c.req.raw.headers,
      body: ['GET', 'HEAD'].includes(c.req.raw.method) ? undefined : await c.req.raw.clone().text(),
    }
    return stub.fetch(`https://internal${path}${url.search}`, init)
  }
}

/** Rewrite a request to a new internal path while keeping headers/method/body. */
function rewritten(req: Request, path: string): Request {
  const url = new URL(req.url)
  return new Request(`https://internal${path}${url.search}`, req)
}

export default app
