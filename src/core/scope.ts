import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { RuntimeConfig } from './types.js'
import { findGitRoot, sha256 } from './utils.js'

export interface ScopePaths {
  memoryRoot: string
  workspaceRoot: string
  workspaceId: string
  workspaceDir: string
  globalDir: string
}

export async function resolveScopePaths(config: RuntimeConfig): Promise<ScopePaths> {
  const memoryRoot = resolve(config.memoryRoot ?? process.env.DSH_MEMORY_ROOT ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'memory-runtime'))
  const configuredWorkspace = config.workspaceRoot ?? process.env.DSH_WORKSPACE_ROOT
  const workspaceRoot = resolve(configuredWorkspace ?? (config.preferGitRoot ? (await findGitRoot(process.cwd()) ?? process.cwd()) : process.cwd()))
  let canonicalRoot = workspaceRoot
  try { canonicalRoot = await realpath(workspaceRoot) } catch { /* the workspace may not exist yet */ }
  const workspaceId = sha256(canonicalRoot.replaceAll('\\', '/')).slice(0, 24)
  return { memoryRoot, workspaceRoot, workspaceId, workspaceDir: join(memoryRoot, 'workspaces', workspaceId), globalDir: join(memoryRoot, 'global') }
}
