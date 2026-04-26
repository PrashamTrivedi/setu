# Protocol

All wire shapes are defined as TypeScript types in `@kanban/protocol`. This
file is a human-readable cross-reference only. When code and prose disagree,
the code wins.

- `BunToWorker` and `WorkerToBun` — JSON over WS.
- `BunToChannel` and `ChannelToBun` — newline-delimited JSON over Unix domain socket.
- MCP standard surface (`notifications/claude/channel`, `tools/call`,
  `notifications/claude/channel/permission_request`) is per the
  [channels reference](https://code.claude.com/docs/en/channels-reference).

## Idempotency

Every `reply_tool_call` carries a `tool_call_id`. Worker dedupes; safe replay
across reconnects (§13).

## Back-channel hello

When a channel server connects to the UDS, the first line it writes is a
`hello` with `(project_id, branch, role, pid)`. Bun routes subsequent inbound
events for that key to that socket; outbound `reply_tool_call` from the same
socket is published to the Worker with the same key.
