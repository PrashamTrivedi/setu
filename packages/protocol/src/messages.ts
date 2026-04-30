import type { DispatchKind, SessionRole } from './domain.ts'

// Channel event payload — what the channel server emits as `notifications/claude/channel`.
// `meta` keys become `<channel>` tag attributes when Claude renders the message.
//
// `peer_message` is fanned out by the Worker when an agent calls the
// `dispatch` reply tool with a `to_role`. The receiving session sees a normal
// `<channel>` block with `from_role` so it can react in-loop.
export type ChannelEventKind =
  | 'card'
  | 'input_response'
  | 'cancel_advisory'
  | 'peer_message'

export interface ChannelEvent {
  content: string
  meta: {
    project_id: string
    branch: string
    card_id: string
    role: SessionRole
    event_kind: ChannelEventKind
    /**
     * On `event_kind: 'peer_message'`, the Worker also sets:
     *   - `from_role`     : the SessionRole that authored the dispatch
     *   - `dispatch_kind` : the DispatchKind from the originating dispatch
     * They flow through the open string index below.
     */
    [extra: string]: string
  }
}

// Reply tools — what Claude calls back to the channel server, which the server
// forwards to Bun (over UDS), which forwards to Worker (over WS).
//
// `dispatch` is the unified authored-voice primitive. It coexists with the
// older tools (`update_card`, `request_input`, `report_progress`) which stay
// for state-machine and step semantics; agents are prompted to use `dispatch`
// for narration aimed at the user (or a peer agent via `to_role`).
export type ReplyToolName =
  | 'update_card'
  | 'request_input'
  | 'report_progress'
  | 'report_step'
  | 'dispatch'

export interface ReplyToolCall<T extends ReplyToolName = ReplyToolName> {
  tool_call_id: string
  tool_name: T
  args: ReplyToolArgs[T]
}

export interface ReplyToolArgs {
  update_card: {
    card_id: string
    status: 'in_progress' | 'done' | 'blocked'
    evidence?: { kind: 'note' | 'link' | 'parakh' | 'sha'; value: string }
  }
  request_input: { card_id: string; prompt: string }
  report_progress: { card_id: string; note: string }
  report_step: {
    card_id: string
    step: string
    status: 'running' | 'ok' | 'failed'
    detail?: string
  }
  /**
   * Authored dispatch from an agent to the user (and optionally a peer agent
   * in the same project). The Worker:
   *   - stores it on the card's feed for the UI
   *   - if `to_role` is set and a session for (project_id, branch, to_role)
   *     exists, emits a `push_event` with `event_kind: 'peer_message'` into
   *     that session so the peer's Claude sees it inline.
   *
   * `default_after_ms` is meaningful only with `kind: 'committing'`. The
   * Worker resolves the dispatch as accepted after that window unless the UI
   * intervenes, and pushes an `input_response` back if the agent is awaiting.
   */
  dispatch: {
    card_id: string
    body: string
    kind: DispatchKind
    to_role?: SessionRole
    default_after_ms?: number
  }
}

// ─── Bun → Worker ────────────────────────────────────────────────────────────
export type BunToWorker =
  | { type: 'hello'; machine_id: string; projects_available: string[]; protocol_version: number }
  | { type: 'heartbeat'; timestamp: number; sessions_live: SessionLiveSummary[] }
  | { type: 'session_registered'; project_id: string; branch: string; role: SessionRole }
  | { type: 'session_terminated'; project_id: string; branch: string; reason: string }
  | {
      type: 'reply_tool_call'
      project_id: string
      branch: string
      tool_call_id: string
      tool_name: ReplyToolName
      args: unknown
    }
  | {
      type: 'permission_request'
      project_id: string
      branch: string
      request_id: string
      tool_name: string
      description: string
      input_preview: string
    }

export interface SessionLiveSummary {
  project_id: string
  branch: string
  role: SessionRole
}

// ─── Worker → Bun ────────────────────────────────────────────────────────────
export type WorkerToBun =
  | {
      type: 'spawn_session'
      project_id: string
      project_path: string
      branch: string
      role: SessionRole
      initial_event?: ChannelEvent
    }
  | { type: 'terminate_session'; project_id: string; branch: string }
  | { type: 'push_event'; project_id: string; branch: string; channel_event: ChannelEvent }
  | { type: 'permission_verdict'; request_id: string; behavior: 'allow' | 'deny' }
  | {
      type: 'ensure_worktree'
      project_id: string
      branch: string
      source_branch?: string
    }

// ─── Bun ↔ Channel-server back-channel (UDS) ─────────────────────────────────
// First message sent by the channel server after connecting to the UDS.
export interface BackChannelHello {
  type: 'hello'
  project_id: string
  branch: string
  role: SessionRole
  pid: number
}

// Bun → channel server
export type BunToChannel =
  | { type: 'channel_event'; event: ChannelEvent }
  | { type: 'permission_verdict'; request_id: string; behavior: 'allow' | 'deny' }

// channel server → Bun
export type ChannelToBun =
  | BackChannelHello
  | {
      type: 'reply_tool_call'
      tool_call_id: string
      tool_name: ReplyToolName
      args: unknown
    }
  | {
      type: 'permission_request'
      request_id: string
      tool_name: string
      description: string
      input_preview: string
    }
