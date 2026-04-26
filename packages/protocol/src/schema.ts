/**
 * Shared SQL schema. Both stores are SQLite — Cloudflare DO storage (via
 * `state.storage.sql`) and Bun's built-in `bun:sqlite` — so a single DDL
 * works on both sides. The Worker is authoritative for metadata
 * (display_name, default_branch, repo_policy); the Bun supervisor is
 * authoritative for `project_path`, which is machine-local and stays NULL on
 * the Worker side.
 */

export const SCHEMA_VERSION = 1

export const PROJECTS_DDL = /* sql */ `
CREATE TABLE IF NOT EXISTS projects (
  project_id     TEXT PRIMARY KEY,
  display_name   TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  repo_policy    TEXT NOT NULL DEFAULT 'own',
  project_path   TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
`

export const CARDS_DDL = /* sql */ `
CREATE TABLE IF NOT EXISTS cards (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  title           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  target_branch   TEXT NOT NULL,
  status          TEXT NOT NULL,
  merge_strategy  TEXT NOT NULL DEFAULT 'squash',
  repo_policy     TEXT NOT NULL DEFAULT 'own',
  evidence_json   TEXT NOT NULL DEFAULT '[]',
  finalize_json   TEXT,
  pending_input   TEXT,
  error           TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS cards_by_project ON cards(project_id, status);
CREATE INDEX IF NOT EXISTS cards_by_branch ON cards(project_id, target_branch);
`

export const ALL_DDL = [PROJECTS_DDL, CARDS_DDL].join('\n')

/** Row shape returned by SQL queries. JSON columns are stringified TEXT. */
export interface ProjectRow {
  project_id: string
  display_name: string
  default_branch: string
  repo_policy: string
  project_path: string | null
  created_at: number
  updated_at: number
}
