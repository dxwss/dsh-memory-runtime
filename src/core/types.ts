export type MemoryScope = 'workspace' | 'global'
export type SearchScope = 'current' | 'global'
export type MemoryStatus = 'active' | 'archived'
export type RelationType = 'NEW' | 'DUPLICATE' | 'REFINE' | 'UPDATE' | 'CONFLICT'

export interface MemoryMetadata {
  id: string
  status: MemoryStatus
  created_at: string
  updated_at: string
  source_session: string
  scope: MemoryScope
  workspace_id?: string
}

export interface MemoryBlock {
  metadata: MemoryMetadata
  topic: string
  title: string
  content: string
  evidence: string
  filePath?: string
}

export interface MemoryCandidate {
  topic: string
  title: string
  content: string
  evidence?: string
  sourceSession?: string
  sourceText?: string
  globalCandidate?: boolean
}

export interface RelationDecision {
  relation: RelationType
  targetMemoryId?: string
  reason: string
  mergedContent?: string
  confidence: number
}

export interface SearchResult {
  memory_id: string
  topic: string
  title: string
  current_content: string
  evidence: string
  updated_at: string
  source_session: string
  scope: MemoryScope
  score: number
}

export interface ReadResult {
  memory_id: string
  version_hash: string
  topic: string
  title?: string
  content?: string
  evidence?: string
  metadata: MemoryMetadata
  already_loaded: boolean
  history?: string[]
}

export interface ProposeResult {
  relation: RelationType
  memory_id?: string
  scope: MemoryScope
  topic: string
  title: string
  reason: string
  confidence: number
  history_written: boolean
  pending_conflict: boolean
}

export interface ValidationIssue {
  severity: 'error' | 'warning'
  scope: MemoryScope
  path: string
  message: string
}

export interface ValidationReport {
  ok: boolean
  issues: ValidationIssue[]
  active_memories: number
  archived_memories: number
  topics: number
}

export interface RuntimeConfig {
  memoryRoot?: string
  workspaceRoot?: string
  preferGitRoot: boolean
  historyEnabled: boolean
  searchTopK: number
  maxBlockBytes: number
  maxTopicCount: number
  maxCandidateBytes: number
  maxOutputBytes: number
  rejectSecrets: boolean
  rejectPromptInjection: boolean
  requireExplicitGlobalSignal: boolean
  minConfidenceForAutoUpdate: number
  lockTimeoutMs: number
  lockRetryMs: number
  deduplicateReads: boolean
  extractIntervalTurns: number
  llmProvider?: string
  llmModel?: string
  llmEnabled: boolean
  extractionEnabled: boolean
  llmTimeoutMs: number
}

export const defaultRuntimeConfig: RuntimeConfig = {
  preferGitRoot: true,
  historyEnabled: true,
  searchTopK: 5,
  maxBlockBytes: 32_768,
  maxTopicCount: 64,
  maxCandidateBytes: 32_768,
  maxOutputBytes: 64_000,
  rejectSecrets: true,
  rejectPromptInjection: true,
  requireExplicitGlobalSignal: true,
  minConfidenceForAutoUpdate: 0.8,
  lockTimeoutMs: 10_000,
  lockRetryMs: 40,
  deduplicateReads: true,
  extractIntervalTurns: 10,
  llmEnabled: true,
  extractionEnabled: true,
  llmTimeoutMs: 30_000,
}

export interface OperationTrace {
  session_id: string
  workspace_id?: string
  candidate_id?: string
  operation: string
  topic?: string
  retrieved_memory_ids?: string[]
  relation?: RelationType
  target_memory_id?: string
  result: string
  latency_ms: number
  error?: string
  timestamp: string
}

export type RelationJudge = (
  candidate: MemoryCandidate,
  existing: MemoryBlock[],
) => Promise<RelationDecision> | RelationDecision

export type CandidateExtractor = (
  turns: readonly string[],
) => Promise<MemoryCandidate[]> | MemoryCandidate[]
