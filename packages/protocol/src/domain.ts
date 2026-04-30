export type CardStatus =
  | 'backlog'
  | 'assigned'
  | 'in_progress'
  | 'done-pending-review'
  | 'approved'
  | 'merging'
  | 'merged'
  | 'cleaning'
  | 'archived'
  | 'merge_failed'
  | 'clean_failed'

export type FinalizeStepStatus = 'pending' | 'running' | 'ok' | 'failed'

export interface FinalizeStep {
  step: string
  status: FinalizeStepStatus
  detail?: string
  at: number
}

export interface CardEvidence {
  kind: 'note' | 'link' | 'parakh' | 'sha'
  value: string
  at: number
}

export type RepoPolicy = 'own' | 'client'
export type MergeStrategy = 'merge' | 'squash' | 'rebase'

export interface Card {
  id: string
  project_id: string
  title: string
  description: string
  target_branch: string
  status: CardStatus
  created_at: number
  updated_at: number
  evidence: CardEvidence[]
  merge_strategy: MergeStrategy
  repo_policy: RepoPolicy
  finalize_steps?: FinalizeStep[]
  pending_input?: { prompt: string; at: number } | null
  error?: string | null
}

export interface Project {
  project_id: string
  display_name: string
  /** Machine-local path on the Bun supervisor side. Worker stores this NULL. */
  project_path?: string | null
  default_branch: string
  repo_policy: RepoPolicy
}

export type SessionRole = 'kanban-work' | 'kanban-ops'
export type SessionState = 'offline' | 'standby' | 'live'

/**
 * The "voice" an agent uses when posting a dispatch. The UI uses this to
 * style and prioritize the card.
 *  - decided   : "I picked X over Y because Z"        (informational)
 *  - asking    : "I need you to choose"               (blocks the card)
 *  - noting    : "fyi I'm doing X"                    (low-noise progress)
 *  - committing: "going with X unless you say otherwise within N ms"
 *                (paired with default_after_ms; auto-resolves on timeout)
 */
export type DispatchKind = 'decided' | 'asking' | 'noting' | 'committing'

/**
 * Scope of a permission verdict. UI → Worker only; the Worker compresses to
 * plain `allow|deny` on the way to Bun, so Claude Code's channel surface is
 * unchanged. The allowlist that backs `branch`/`forever` is held in the
 * Worker DO, not on the wire.
 */
export type PermissionScope = 'once' | 'branch' | 'forever'

export interface SessionKey {
  project_id: string
  branch: string
}

export interface SessionInfo extends SessionKey {
  role: SessionRole
  state: SessionState
  machine_id: string
  registered_at: number
}

const STATUS_TRANSITIONS: Record<CardStatus, readonly CardStatus[]> = {
  backlog: ['assigned'],
  assigned: ['in_progress', 'backlog'],
  in_progress: ['done-pending-review', 'backlog'],
  'done-pending-review': ['approved', 'in_progress'],
  approved: ['merging'],
  merging: ['merged', 'merge_failed'],
  merged: ['cleaning'],
  cleaning: ['archived', 'clean_failed'],
  archived: [],
  merge_failed: ['merging'],
  clean_failed: ['cleaning'],
}

export function canTransition(from: CardStatus, to: CardStatus): boolean {
  return STATUS_TRANSITIONS[from].includes(to)
}

export function nextStatuses(from: CardStatus): readonly CardStatus[] {
  return STATUS_TRANSITIONS[from]
}
