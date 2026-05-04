import type { Card, CardStatus, DispatchKind, PermissionScope, SessionRole } from '@kanban/protocol'

export const UI_PROTOCOL_VERSION = 1 as const

// ─── Shared shapes ───────────────────────────────────────────────────────────

export interface PushSubscriptionJSON {
  endpoint: string
  expirationTime?: number | null
  keys: { p256dh: string; auth: string }
}

export interface UserSummary {
  client_id: string
  machines: MachineSummary[]
  projects: ProjectSummary[]
}

export interface MachineSummary {
  machine_id: string
  projects: string[]
  connected_at: number
}

export interface ProjectSummary {
  project_id: string
  display_name?: string
  last_active_at?: number
}

export interface SessionLiveSummary {
  project_id: string
  branch: string
  role: SessionRole
}

export interface CardSummary {
  id: string
  project_id: string
  title: string
  status: CardStatus
  target_branch: string
  updated_at: number
}

export interface PermissionRequestSummary {
  request_id: string
  project_id: string
  branch: string
  card_id?: string
  tool_name: string
  description: string
  input_preview: string
  asked_at: number
}

// ─── Feed item ───────────────────────────────────────────────────────────────

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

// ─── UI → Worker ─────────────────────────────────────────────────────────────

export type UiToWorker =
  | { type: 'hello'; client_id: string; bearer: string }
  | { type: 'subscribe'; project_ids: string[] }
  | { type: 'unsubscribe'; project_ids: string[] }
  | { type: 'replay'; project_id: string; since?: number }
  | {
      type: 'permission_verdict'
      request_id: string
      behavior: 'allow' | 'deny'
      scope: PermissionScope
    }
  | { type: 'redirect'; project_id: string; card_id: string; body: string }
  | { type: 'spawn_card'; project_id: string; card_id: string }
  | { type: 'register_push'; subscription: PushSubscriptionJSON }
  | { type: 'unregister_push' }
  | { type: 'set_quiet_hours'; from: string; to: string; tz: string }
  | { type: 'clear_quiet_hours' }
  | { type: 'pong'; ts: number }

// ─── Worker → UI ─────────────────────────────────────────────────────────────

export type WorkerToUi =
  | { type: 'welcome'; me: UserSummary; ui_protocol_version: number }
  | { type: 'feed_item'; project_id: string; item: FeedItem }
  | { type: 'feed_replay'; project_id: string; items: FeedItem[] }
  | {
      type: 'project_state'
      project_id: string
      cards: CardSummary[]
      pending_perms: PermissionRequestSummary[]
    }
  | {
      type: 'fleet'
      sessions_live: SessionLiveSummary[]
      machines: MachineSummary[]
    }
  | { type: 'digest'; project_id: string; items: FeedItem[] }
  | { type: 'error'; reason: string }
  | { type: 'ping'; ts: number }

// ─── Convenience re-exports ──────────────────────────────────────────────────
export type { Card, CardStatus, DispatchKind, PermissionScope, SessionRole }
