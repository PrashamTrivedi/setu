import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * Bun does worktree filesystem ops only — `git worktree add` so the directory
 * exists at the expected path. Branch creation falls to git; merge/push/delete
 * are exclusively kanban-ops Claude territory (privilege model §9).
 */
export async function ensureWorktree(
  projectPath: string,
  branch: string,
  sourceBranch?: string,
): Promise<string> {
  const safe = branch.replace(/[^a-zA-Z0-9._/-]/g, '-')
  const wtRoot = resolve(projectPath, '..', `.${pathBaseName(projectPath)}-worktrees`)
  const wtPath = join(wtRoot, safe.replace(/\//g, '__'))
  if (existsSync(wtPath)) return wtPath

  const args = ['worktree', 'add']
  if (sourceBranch) args.push('-b', branch, wtPath, sourceBranch)
  else args.push(wtPath, branch)

  const proc = Bun.spawn(['git', ...args], { cwd: projectPath, stderr: 'pipe', stdout: 'pipe' })
  const code = await proc.exited
  if (code !== 0) {
    const err = await new Response(proc.stderr).text()
    throw new Error(`git worktree add failed: ${err.trim()}`)
  }
  return wtPath
}

function pathBaseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? 'repo'
}
