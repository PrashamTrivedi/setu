#!/usr/bin/env bun
import {
  type ToolDefinition,
  dispatchToolDefinition,
  runChannelServer,
} from '@kanban/channel-runtime'
import type { ReplyToolName } from '@kanban/protocol'

const tools: ToolDefinition[] = [
  {
    name: 'update_card',
    description:
      'Advance the card state machine. Pass status="done" when work is ready for human review; status="in_progress" while actively working; status="blocked" if you need to surface a blocker.',
    inputSchema: {
      type: 'object',
      properties: {
        card_id: { type: 'string' },
        status: { type: 'string', enum: ['in_progress', 'done', 'blocked'] },
        evidence: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['note', 'link', 'parakh', 'sha'] },
            value: { type: 'string' },
          },
          required: ['kind', 'value'],
        },
      },
      required: ['card_id', 'status'],
    },
  },
  {
    name: 'request_input',
    description:
      'Block this card and ask the human a question. The answer arrives as a channel event with event_kind="input_response".',
    inputSchema: {
      type: 'object',
      properties: {
        card_id: { type: 'string' },
        prompt: { type: 'string' },
      },
      required: ['card_id', 'prompt'],
    },
  },
  {
    name: 'report_progress',
    description: 'Append-only progress note shown on the card.',
    inputSchema: {
      type: 'object',
      properties: {
        card_id: { type: 'string' },
        note: { type: 'string' },
      },
      required: ['card_id', 'note'],
    },
  },
  dispatchToolDefinition,
]

await runChannelServer({
  role: 'kanban-work',
  serverName: 'kanban-work',
  serverVersion: '0.1.0',
  tools,
  onToolCall: async (name, args, forward) => {
    forward({
      type: 'reply_tool_call',
      tool_call_id: crypto.randomUUID(),
      tool_name: name as ReplyToolName,
      args,
    })
    return { content: [{ type: 'text', text: 'queued' }] }
  },
})
