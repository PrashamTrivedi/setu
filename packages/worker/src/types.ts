import type { DurableObjectNamespace } from '@cloudflare/workers-types'
import type { CardStatus, DispatchKind, PermissionScope, SessionRole } from '@kanban/protocol'

export interface Env {
  PROJECT_DO: DurableObjectNamespace
  MACHINE_DO: DurableObjectNamespace
  USER_DO: DurableObjectNamespace
  BUN_SHARED_TOKEN?: string
  UI_BEARER?: string
  ALLOWED_PROJECTS?: string
  VAPID_PUBLIC_KEY?: string
  VAPID_PRIVATE_KEY?: string
  VAPID_SUBJECT?: string
}

// ─── Internal feed shapes (server-side mirror of @kanban/ui-protocol) ────────
// Kept here so the Worker can build feed items without importing the
// UI-protocol package on hot paths; the wire shape is a strict superset of
// FeedItem in @kanban/ui-protocol.

export type FeedItem =
  | {
      id: string
      seq: number
      ts: number
      kind: 'dispatch'
      project_id: string
      card_id: string
      from_role: SessionRole
      dispatch_kind: DispatchKind
      body: string
      to_role?: SessionRole
      committing?: {
        default_after_ms: number
        deadline: number
        resolved?: boolean
      }
    }
  | {
      id: string
      seq: number
      ts: number
      kind: 'perm_ask'
      project_id: string
      card_id?: string
      request_id: string
      tool_name: string
      description: string
      input_preview: string
      resolved?: { behavior: 'allow' | 'deny'; scope: PermissionScope; at: number }
    }
  | {
      id: string
      seq: number
      ts: number
      kind: 'card_state'
      project_id: string
      card_id: string
      from: CardStatus
      to: CardStatus
    }
  | {
      id: string
      seq: number
      ts: number
      kind: 'peer_in'
      project_id: string
      card_id: string
      from_role: SessionRole
      body: string
    }

export interface CommittingAlarmRecord {
  dispatch_id: string
  card_id: string
  project_id: string
  feed_seq: number
  deadline: number
  /** tool_call_id of the committing dispatch (for idempotency on auto-resolve). */
  tool_call_id: string
  /** If a request_input was paired before the deadline, the Worker auto-replies. */
  paired_request_tool_call_id?: string
  branch: string
}

export interface PendingPermission {
  request_id: string
  project_id: string
  branch: string
  tool_name: string
  description: string
  input_preview: string
  fingerprint: string
  asked_at: number
  feed_seq: number
}
