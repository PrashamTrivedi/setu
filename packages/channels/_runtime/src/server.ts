import type { BunToChannel, ChannelEvent, ChannelToBun, SessionRole } from '@kanban/protocol'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  NotificationSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { connectBackChannel } from './back-channel-client.ts'

/**
 * MCP `setNotificationHandler` requires a Zod object schema with a `method`
 * literal field. The earlier hand-rolled `{ method: '...' } as never` form
 * compiled but crashed at runtime with `Schema is missing a method literal`
 * inside the SDK's zod→jsonschema compat layer (zod-json-schema-compat.js).
 */
const PermissionRequestParamsSchema = z.object({
  tool_name: z.string().optional(),
  description: z.string().optional(),
  input_preview: z.string().optional(),
})

const PermissionRequestNotificationSchema = NotificationSchema.extend({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: PermissionRequestParamsSchema,
})

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] }
}

/**
 * Shared `dispatch` tool definition. Both roles register this so any agent
 * can author a dispatch to the user (and optionally route to a peer role).
 * Worker handles fan-out: stores on the card feed and (if `to_role` is set)
 * emits a peer_message channel event into the target session.
 */
export const dispatchToolDefinition: ToolDefinition = {
  name: 'dispatch',
  description:
    'Author a short, first-person message addressed to the human (and optionally a peer agent). Use this for narration, decisions, asks, and commitments — not for state machine moves (use update_card / report_step for those). kind="decided" reports a choice made; kind="asking" blocks the card on a question; kind="noting" is low-noise progress; kind="committing" pairs with default_after_ms — the dispatch auto-resolves as accepted after that window unless the user intervenes. Set to_role only when you want a peer agent in the same project to see this inline.',
  inputSchema: {
    type: 'object',
    properties: {
      card_id: { type: 'string' },
      body: { type: 'string' },
      kind: { type: 'string', enum: ['decided', 'asking', 'noting', 'committing'] },
      to_role: { type: 'string', enum: ['kanban-work', 'kanban-ops'] },
      default_after_ms: { type: 'number' },
    },
    required: ['card_id', 'body', 'kind'],
  },
}

export interface ChannelServerOptions {
  role: SessionRole
  serverName: string
  serverVersion: string
  tools: ToolDefinition[]
  /** Called when Claude invokes one of the declared tools. */
  onToolCall: (
    toolName: string,
    args: unknown,
    forward: (call: ChannelToBun) => void,
  ) => Promise<{ content: Array<{ type: 'text'; text: string }> }>
}

/**
 * Read-once-from-env wiring. Bun spawns Claude with these env vars set
 * (sessions.ts), and Claude in turn launches the channel server inheriting
 * them. Sender gating (§5.3.2) compares each inbound `meta.project_id` to
 * the project_id we were spawned for.
 */
function readSpawnContext() {
  const project_id = process.env.KANBAN_PROJECT_ID
  const branch = process.env.KANBAN_BRANCH
  const role = process.env.KANBAN_ROLE as SessionRole | undefined
  const socketPath = process.env.KANBAN_SOCKET_PATH
  if (!project_id || !branch || !role || !socketPath) {
    throw new Error(
      'kanban channel server: missing required env (KANBAN_PROJECT_ID, KANBAN_BRANCH, KANBAN_ROLE, KANBAN_SOCKET_PATH)',
    )
  }
  return { project_id, branch, role, socketPath }
}

function newToolCallId(): string {
  return crypto.randomUUID()
}

/** 5-letter request id, no `l` (per channels permission spec). */
function newRequestId(): string {
  const alphabet = 'abcdefghijkmnopqrstuvwxyz'
  let out = ''
  for (let i = 0; i < 5; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return out
}

/**
 * Boots the MCP stdio server, declares channel + permission capabilities,
 * connects to Bun's UDS, and wires inbound channel events into MCP
 * `notifications/claude/channel` plus the reply-tool surface.
 */
export async function runChannelServer(opts: ChannelServerOptions): Promise<void> {
  const ctx = readSpawnContext()
  console.error(
    `[${opts.serverName}] starting — pid=${process.pid} project=${ctx.project_id} branch=${ctx.branch} role=${ctx.role} socket=${ctx.socketPath}`,
  )
  if (ctx.role !== opts.role) {
    throw new Error(
      `kanban channel server: role mismatch — env says ${ctx.role}, server expects ${opts.role}`,
    )
  }

  const server = new Server(
    { name: opts.serverName, version: opts.serverVersion },
    {
      capabilities: {
        experimental: {
          'claude/channel': {},
          'claude/channel/permission': {},
        },
        tools: {},
      },
    },
  )

  // Start the back-channel connection in the background so a slow or absent
  // UDS doesn't block the MCP stdio handshake. Outbound tool calls get
  // buffered until the back-channel is live; this prevents a "MCP server is
  // not yet connected" error in Claude when Bun is briefly unreachable.
  const outbox: ChannelToBun[] = []
  let liveSend: ((msg: ChannelToBun) => void) | null = null
  const back = {
    send(msg: ChannelToBun) {
      if (liveSend) liveSend(msg)
      else outbox.push(msg)
    },
  }
  void (async () => {
    let attempt = 0
    while (true) {
      try {
        const conn = await connectBackChannel({
          socketPath: ctx.socketPath,
          project_id: ctx.project_id,
          branch: ctx.branch,
          role: ctx.role,
          onIncoming: (msg) => onBunMessage(msg),
        })
        liveSend = conn.send
        console.error(
          `[${opts.serverName}] back-channel connected (socket=${ctx.socketPath}); flushing ${outbox.length} buffered`,
        )
        while (outbox.length > 0) {
          const m = outbox.shift()
          if (m) conn.send(m)
        }
        return // internal reconnect handles drops thereafter
      } catch (err) {
        attempt++
        const m = err instanceof Error ? err.message : String(err)
        const wait = Math.min(500 * 2 ** Math.min(attempt, 5), 10_000)
        console.error(
          `[${opts.serverName}] back-channel connect failed (attempt ${attempt}): ${m} — retrying in ${wait}ms`,
        )
        await new Promise((r) => setTimeout(r, wait))
      }
    }
  })()

  function onBunMessage(msg: BunToChannel): void {
    if (msg.type === 'channel_event') {
      const ev = msg.event
      // Sender gating: the trust boundary is the Worker DO, but enforce here too.
      if (ev.meta.project_id !== ctx.project_id || ev.meta.branch !== ctx.branch) {
        console.error(
          '[channel] dropped event with mismatched project/branch',
          ev.meta.project_id,
          ev.meta.branch,
        )
        return
      }
      void emitChannelEvent(ev)
      return
    }
    if (msg.type === 'permission_verdict') {
      void server.notification({
        method: 'notifications/claude/channel/permission',
        params: { request_id: msg.request_id, behavior: msg.behavior },
      })
      return
    }
  }

  async function emitChannelEvent(ev: ChannelEvent): Promise<void> {
    await server.notification({
      method: 'notifications/claude/channel',
      params: { content: ev.content, meta: ev.meta },
    })
  }

  // Tool surface
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: opts.tools }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const toolCallId = newToolCallId()
    return await opts.onToolCall(req.params.name, req.params.arguments, (call) => {
      // Forward to Bun. If the caller didn't set tool_call_id, supply one.
      const outbound: ChannelToBun =
        call.type === 'reply_tool_call' && !call.tool_call_id
          ? { ...call, tool_call_id: toolCallId }
          : call
      back.send(outbound)
    })
  })

  // Permission relay (v1.5): Claude pings us with permission_request → we
  // forward to Bun → Worker UI surfaces it. Verdict comes back via
  // BunToChannel.permission_verdict above.
  server.setNotificationHandler(PermissionRequestNotificationSchema, async (notif) => {
    const params = notif.params as
      | { tool_name?: string; description?: string; input_preview?: string }
      | undefined
    const requestId = newRequestId()
    back.send({
      type: 'permission_request',
      request_id: requestId,
      tool_name: params?.tool_name ?? 'unknown',
      description: params?.description ?? '',
      input_preview: params?.input_preview ?? '',
    })
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(
    `[${opts.serverName}] online — project=${ctx.project_id} branch=${ctx.branch} role=${ctx.role}`,
  )
}

export const helpers = { newToolCallId, newRequestId }
