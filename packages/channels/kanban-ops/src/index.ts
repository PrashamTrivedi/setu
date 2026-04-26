#!/usr/bin/env bun
import { type ToolDefinition, runChannelServer } from '@kanban/channel-runtime'

const tools: ToolDefinition[] = [
  {
    name: 'report_step',
    description:
      'Drive the finalize state machine. Use step="merge" with status="ok"|"failed" after merging; step="cleanup" with status="running"|"ok"|"failed" during/after worktree+branch cleanup.',
    inputSchema: {
      type: 'object',
      properties: {
        card_id: { type: 'string' },
        step: { type: 'string' },
        status: { type: 'string', enum: ['running', 'ok', 'failed'] },
        detail: { type: 'string' },
      },
      required: ['card_id', 'step', 'status'],
    },
  },
]

await runChannelServer({
  role: 'kanban-ops',
  serverName: 'kanban-ops',
  serverVersion: '0.1.0',
  tools,
  onToolCall: async (name, args, forward) => {
    forward({
      type: 'reply_tool_call',
      tool_call_id: crypto.randomUUID(),
      tool_name: name as 'report_step',
      args,
    })
    return { content: [{ type: 'text', text: 'queued' }] }
  },
})
