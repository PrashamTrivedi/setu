import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { ALL_DDL, type ProjectRow } from '@kanban/protocol'

export interface AddProjectInput {
  project_id: string
  project_path: string
  display_name?: string
  default_branch?: string
  repo_policy?: 'own' | 'client'
}

export class LocalStore {
  private db: Database

  constructor(db: Database) {
    this.db = db
    this.db.exec(ALL_DDL)
  }

  addProject(input: AddProjectInput): ProjectRow {
    const now = Date.now()
    const row: ProjectRow = {
      project_id: input.project_id,
      display_name: input.display_name ?? input.project_id,
      default_branch: input.default_branch ?? 'main',
      repo_policy: input.repo_policy ?? 'own',
      project_path: input.project_path,
      created_at: now,
      updated_at: now,
    }
    this.db
      .query(
        `INSERT INTO projects (project_id, display_name, default_branch, repo_policy, project_path, created_at, updated_at)
         VALUES ($project_id, $display_name, $default_branch, $repo_policy, $project_path, $created_at, $updated_at)
         ON CONFLICT(project_id) DO UPDATE SET
           display_name   = excluded.display_name,
           default_branch = excluded.default_branch,
           repo_policy    = excluded.repo_policy,
           project_path   = excluded.project_path,
           updated_at     = excluded.updated_at`,
      )
      .run({
        $project_id: row.project_id,
        $display_name: row.display_name,
        $default_branch: row.default_branch,
        $repo_policy: row.repo_policy,
        $project_path: row.project_path,
        $created_at: row.created_at,
        $updated_at: row.updated_at,
      })
    return row
  }

  getProject(project_id: string): ProjectRow | undefined {
    const row = this.db
      .query<ProjectRow, { $id: string }>('SELECT * FROM projects WHERE project_id = $id')
      .get({ $id: project_id })
    return row ?? undefined
  }

  listProjects(): ProjectRow[] {
    return this.db.query<ProjectRow, []>('SELECT * FROM projects ORDER BY project_id').all()
  }

  removeProject(project_id: string): boolean {
    const res = this.db
      .query('DELETE FROM projects WHERE project_id = $id')
      .run({ $id: project_id })
    return res.changes > 0
  }

  close(): void {
    this.db.close()
  }
}

export function defaultDbPath(): string {
  const xdg = process.env.XDG_DATA_HOME
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.local', 'share')
  return join(base, 'kanban-bun', 'state.db')
}

export function openStore(path?: string): LocalStore {
  const target = path ?? process.env.KANBAN_DB_PATH ?? defaultDbPath()
  if (target !== ':memory:') mkdirSync(dirname(target), { recursive: true })
  return new LocalStore(new Database(target))
}
