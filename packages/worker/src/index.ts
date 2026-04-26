/// <reference types="@cloudflare/workers-types" />
import { Hono } from 'hono'
import type { Env } from './types.ts'
import { indexHtml } from './ui.ts'

export { ProjectDO } from './project-do.ts'
export { MachineDO } from './machine-do.ts'

const app = new Hono<{ Bindings: Env }>()

// ─── UI ────────────────────────────────────────────────────────────────────
app.get('/', (c) => c.html(indexHtml))

// ─── Card CRUD + lifecycle (proxies to DO) ─────────────────────────────────
app.all('/api/projects/:projectId/cards', forwardToProject('/cards'))
app.all('/api/projects/:projectId/cards/:cardId/:action{approve|spawn|input}', (c) => {
  const { cardId, action } = c.req.param()
  return forwardToProject(`/cards/${cardId}/${action}`)(c)
})

// SSE tick every 3s so the client re-GETs /cards. Stateless.
app.get('/api/projects/:projectId/stream', (c) => {
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder()
      const send = () => {
        try {
          controller.enqueue(enc.encode('data: tick\n\n'))
        } catch {}
      }
      const t = setInterval(send, 3000)
      send()
      c.req.raw.signal.addEventListener('abort', () => {
        clearInterval(t)
        try {
          controller.close()
        } catch {}
      })
    },
  })
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    },
  })
})

// ─── Registry: list known projects + machines ─────────────────────────────
app.get('/api/projects', async (c) => {
  const stub = projectStub(c.env, '__registry__')
  return stub.fetch('https://internal/_registry/list')
})

app.get('/api/projects/:projectId/status', forwardToProject('/status'))

// ─── Bun supervisor WS endpoint (machine-keyed) ───────────────────────────
app.get('/ws/bun/:machineId', async (c) => {
  const machineId = c.req.param('machineId')
  if (!machineId) return c.text('machine_id required', 400)
  const id = c.env.MACHINE_DO.idFromName(machineId)
  const stub = c.env.MACHINE_DO.get(id)
  // Stash the machine_id in the DO so it knows its own name (for state.id is opaque)
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

export default app
