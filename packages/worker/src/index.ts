/// <reference types="@cloudflare/workers-types" />
import { Hono } from 'hono'
import type { Env } from './types.ts'
import { indexHtml } from './ui.ts'

export { ProjectDO } from './project-do.ts'

const app = new Hono<{ Bindings: Env }>()

// ─── UI ────────────────────────────────────────────────────────────────────
app.get('/', (c) => c.html(indexHtml))

// ─── Card CRUD + lifecycle (proxies to DO) ─────────────────────────────────
app.all('/api/projects/:projectId/cards', forwardToDo('/cards'))
app.all('/api/projects/:projectId/cards/:cardId/:action{approve|spawn|input}', (c) => {
  const { cardId, action } = c.req.param()
  return forwardToDo(`/cards/${cardId}/${action}`)(c)
})

// ─── SSE: poll DO via WS, fan out as SSE so the embedded UI stays cookie-free ─
app.get('/api/projects/:projectId/stream', async (c) => {
  const projectId = c.req.param('projectId')
  const stub = projectStub(c.env, projectId)
  const ws = new WebSocket('https://internal/__ws/ui') // fake URL for typing
  // Easier: just emit an SSE tick every 3s and let client GET cards on each tick.
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder()
      const send = () => controller.enqueue(enc.encode('data: tick\n\n'))
      const t = setInterval(send, 3000)
      send()
      c.req.raw.signal.addEventListener('abort', () => {
        clearInterval(t)
        controller.close()
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

// ─── Bun supervisor WS endpoint ────────────────────────────────────────────
app.get('/ws/bun/:projectId', async (c) => {
  const stub = projectStub(c.env, c.req.param('projectId'))
  return stub.fetch('https://internal/__ws/bun', c.req.raw)
})

// ─── Helpers ───────────────────────────────────────────────────────────────
function projectStub(env: Env, projectId: string) {
  const id = env.PROJECT_DO.idFromName(projectId)
  return env.PROJECT_DO.get(id)
}

function forwardToDo(path: string) {
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
