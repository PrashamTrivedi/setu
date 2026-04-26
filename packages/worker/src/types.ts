import type { DurableObjectNamespace } from '@cloudflare/workers-types'

export interface Env {
  PROJECT_DO: DurableObjectNamespace
  MACHINE_DO: DurableObjectNamespace
  BUN_SHARED_TOKEN?: string
  ALLOWED_PROJECTS?: string
}
