import type { BunToChannel, ChannelEvent, ChannelToBun, SessionRole } from '@kanban/protocol'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { connectBackChannel } from './back-channel-client.ts'

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

  const back = await connectBackChannel({
    socketPath: ctx.socketPath,
    project_id: ctx.project_id,
    branch: ctx.branch,
    role: ctx.role,
    onIncoming: (msg) => onBunMessage(msg),
  })

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
  server.setNotificationHandler(
    { method: 'notifications/claude/channel/permission_request' } as never,
    async (notif: {
      params?: { tool_name?: string; description?: string; input_preview?: string }
    }) => {
      const requestId = newRequestId()
      back.send({
        type: 'permission_request',
        request_id: requestId,
        tool_name: notif.params?.tool_name ?? 'unknown',
        description: notif.params?.description ?? '',
        input_preview: notif.params?.input_preview ?? '',
      })
    },
  )

  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(
    `[${opts.serverName}] online — project=${ctx.project_id} branch=${ctx.branch} role=${ctx.role}`,
  )
}

export const helpers = { newToolCallId, newRequestId }
