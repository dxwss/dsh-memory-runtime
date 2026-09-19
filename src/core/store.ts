import { appendFile, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { ContextEpoch } from '../context/epoch.js'
import { judgeRelation, normalizeCandidate } from '../relation/heuristic.js'
import { Bm25Index } from '../retrieval/bm25.js'
import { withFileLock } from './lock.js'
import { parseTopicFile, serializeMemoryBlock, serializeTopicFile } from './parser.js'
import { resolveScopePaths, type ScopePaths } from './scope.js'
import type {
  MemoryBlock,
  MemoryCandidate,
  MemoryMetadata,
  MemoryScope,
  OperationTrace,
  ProposeResult,
  ReadResult,
  RelationDecision,
  RelationJudge,
  RuntimeConfig,
  SearchResult,
  SearchScope,
  ValidationIssue,
  ValidationReport,
} from './types.js'
import { defaultRuntimeConfig } from './types.js'
import {
  atomicWrite,
  clampText,
  createMemoryId,
  ensureInside,
  isMissing,
  nowIso,
  readTextOrEmpty,
  safeTopicSlug,
  sha256,
} from './utils.js'

const memoryFileName = 'MEMORY.md'
const historyDirName = '.history'
const conflictFileName = 'pending-conflicts.jsonl'
const traceFileName = 'traces.jsonl'
const secretPatterns = [
  /(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|secret)\s*[:=]\s*[^\s]+/iu,
  /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/u,
  /(?:ghp|github_pat|sk-[a-z0-9_-]{12,})[a-z0-9_-]*/iu,
  /(?:AKIA|ASIA)[A-Z0-9]{16}/u,
]

export interface StoreOptions {
  sessionId?: string
  config?: Partial<RuntimeConfig>
  relationJudge?: RelationJudge
}

export interface StoreStats {
  workspace_id: string
  workspace_root: string
  memory_root: string
  active_memories: number
  archived_memories: number
  topics: number
}

export class MemoryStore {
  readonly config: RuntimeConfig
  readonly paths: ScopePaths
  readonly epoch = new ContextEpoch()
  readonly sessionId: string
  private readonly relationJudge: RelationJudge
  private initialized = false
  private readonly traces: OperationTrace[] = []

  private constructor(paths: ScopePaths, options: StoreOptions) {
    this.paths = paths
    this.config = { ...defaultRuntimeConfig, ...options.config }
    this.sessionId = options.sessionId?.trim() || `session_${Date.now().toString(36)}`
    this.relationJudge = options.relationJudge ?? judgeRelation
  }

  static async create(options: StoreOptions = {}): Promise<MemoryStore> {
    const config = { ...defaultRuntimeConfig, ...options.config }
    const paths = await resolveScopePaths(config)
    const store = new MemoryStore(paths, options)
    await store.ensureLayout()
    return store
  }

  private async ensureLayout(): Promise<void> {
    await mkdir(this.paths.workspaceDir, { recursive: true })
    await mkdir(this.paths.globalDir, { recursive: true })
    await this.ensureIndex(this.paths.workspaceDir)
    await this.ensureIndex(this.paths.globalDir)
    this.initialized = true
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error('MemoryStore is not initialized')
  }

  private scopeDir(scope: MemoryScope): string {
    return scope === 'global' ? this.paths.globalDir : this.paths.workspaceDir
  }

  private scopeLock(scope: MemoryScope): string {
    return join(this.scopeDir(scope), '.lock')
  }

  private async ensureIndex(dir: string): Promise<void> {
    const path = join(dir, memoryFileName)
    if (!(await this.exists(path))) await atomicWrite(path, '# Memory Index\n\n')
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await readFile(path)
      return true
    } catch (error) {
      if (isMissing(error)) return false
      throw error
    }
  }

  private record(trace: Omit<OperationTrace, 'timestamp' | 'latency_ms' | 'session_id'> & { started: number }): void {
    const { started, ...rest } = trace
    const item: OperationTrace = { ...rest, session_id: this.sessionId, latency_ms: Date.now() - started, timestamp: nowIso() }
    this.traces.push(item)
    if (this.traces.length > 200) this.traces.shift()
    void appendFile(join(this.paths.workspaceDir, traceFileName), `${JSON.stringify(item)}\n`, 'utf8').catch(() => undefined)
  }

  get recentTraces(): readonly OperationTrace[] {
    return this.traces
  }

  async list(scope: MemoryScope = 'workspace', topic?: string): Promise<MemoryBlock[]> {
    this.assertInitialized()
    const files = await this.topicFiles(scope)
    const blocks: MemoryBlock[] = []
    for (const filePath of files) {
      const parsed = parseTopicFile(await readFile(filePath, 'utf8'), filePath)
      if (topic && parsed.topic.toLocaleLowerCase() !== topic.toLocaleLowerCase() && basename(filePath, '.md') !== safeTopicSlug(topic)) continue
      blocks.push(...parsed.blocks)
    }
    return blocks
  }

  async search(query: string, scope: SearchScope = 'current', topK = this.config.searchTopK, topic?: string): Promise<SearchResult[]> {
    this.assertInitialized()
    const started = Date.now()
    const scopes: MemoryScope[] = scope === 'global' ? ['global'] : ['workspace']
    const blocks: MemoryBlock[] = []
    for (const selected of scopes) blocks.push(...(await this.list(selected, topic)).filter((block) => block.metadata.status === 'active'))
    const index = new Bm25Index(blocks.map((block) => ({
      value: block,
      text: `${block.topic} ${block.title} ${block.content} ${block.evidence} ${block.metadata.workspace_id ?? ''}`,
    })))
    const results = index.search(query, Math.max(0, Math.min(topK, 50))).map(({ value, score }) => ({
      memory_id: value.metadata.id,
      topic: value.topic,
      title: value.title,
      current_content: clampText(value.content, this.config.maxOutputBytes),
      evidence: clampText(value.evidence, Math.min(this.config.maxOutputBytes, 4000)),
      updated_at: value.metadata.updated_at,
      source_session: value.metadata.source_session,
      scope: value.metadata.scope,
      score,
    }))
    this.record({ started, operation: 'MEMORY_SEARCH', workspace_id: this.paths.workspaceId, topic, retrieved_memory_ids: results.map((item) => item.memory_id), result: 'ok' })
    return results
  }

  async read(memoryId: string, includeHistory = false, forceReload = false): Promise<ReadResult> {
    this.assertInitialized()
    const started = Date.now()
    if (!/^mem_[a-z0-9_-]+$/iu.test(memoryId)) throw new Error('Invalid memory_id')
    const block = await this.findById(memoryId)
    if (!block) throw new Error(`Memory not found: ${memoryId}`)
    const versionHash = sha256(`${block.metadata.updated_at}\n${block.content}\n${block.evidence}`)
    const alreadyLoaded = this.config.deduplicateReads && !forceReload && this.epoch.hasLoaded(memoryId, versionHash)
    if (!alreadyLoaded) this.epoch.markLoaded(memoryId, versionHash)
    const history = includeHistory ? await this.readHistory(block) : undefined
    const result: ReadResult = {
      memory_id: memoryId,
      version_hash: versionHash,
      topic: block.topic,
      metadata: block.metadata,
      already_loaded: alreadyLoaded,
      ...(alreadyLoaded ? {} : { title: block.title, content: clampText(block.content, this.config.maxOutputBytes), evidence: clampText(block.evidence, 4000) }),
      ...(history ? { history } : {}),
    }
    this.record({ started, operation: 'MEMORY_READ', workspace_id: this.paths.workspaceId, target_memory_id: memoryId, result: 'ok' })
    return result
  }

  async propose(input: MemoryCandidate): Promise<ProposeResult> {
    this.assertInitialized()
    const started = Date.now()
    const candidate = normalizeCandidate(input)
    this.validateCandidate(candidate)
    const scope = this.resolveCandidateScope(candidate)
    let existing: MemoryBlock[] = []
    const result = await withFileLock(this.scopeLock(scope), scope, this.config.lockTimeoutMs, this.config.lockRetryMs, async () => {
      const selectedBlocks = (await this.list(scope)).filter((block) => block.metadata.status === 'active')
      existing = await this.searchCandidate(candidate, selectedBlocks)
      const decision = await this.relationJudge(candidate, existing)
      return this.applyDecision(scope, candidate, decision, existing)
    })
    this.record({ started, operation: 'MEMORY_PROPOSE', workspace_id: this.paths.workspaceId, candidate_id: candidate.sourceSession, topic: candidate.topic, retrieved_memory_ids: existing.map((block) => block.metadata.id), relation: result.relation, target_memory_id: result.memory_id, result: 'ok' })
    return result
  }

  private async searchCandidate(candidate: MemoryCandidate, blocks: MemoryBlock[]): Promise<MemoryBlock[]> {
    if (blocks.length === 0) return []
    const topicMatches = blocks.filter((block) => block.topic.toLocaleLowerCase() === candidate.topic.toLocaleLowerCase())
    const pool = topicMatches.length > 0 ? topicMatches : blocks
    const index = new Bm25Index(pool.map((block) => ({ value: block, text: `${block.topic} ${block.title} ${block.content} ${block.evidence}` })))
    return index.search(`${candidate.title} ${candidate.content}`, Math.max(this.config.searchTopK, 8)).map((item) => item.value)
  }

  private resolveCandidateScope(candidate: MemoryCandidate): MemoryScope {
    if (!candidate.globalCandidate || !this.config.requireExplicitGlobalSignal) return 'workspace'
    const source = `${candidate.sourceText ?? ''} ${candidate.content}`
    const explicit = /\b(?:all|every|any)\s+(?:project|workspace|repository)s?\b|所有项目|所有工作区|跨项目|全局|以后所有/u.test(source)
    return explicit ? 'global' : 'workspace'
  }

  private async applyDecision(scope: MemoryScope, candidate: MemoryCandidate, decision: RelationDecision, existing: MemoryBlock[]): Promise<ProposeResult> {
    if (decision.relation !== 'NEW' && !decision.targetMemoryId) decision.relation = 'NEW'
    if ((decision.relation === 'UPDATE' || decision.relation === 'REFINE') && decision.confidence < this.config.minConfidenceForAutoUpdate) {
      decision = { ...decision, relation: 'CONFLICT', reason: `${decision.reason} Confidence is below the automatic update threshold.` }
    }
    const target = decision.targetMemoryId ? existing.find((block) => block.metadata.id === decision.targetMemoryId) : undefined
    if (decision.relation === 'DUPLICATE') return { relation: decision.relation, memory_id: target?.metadata.id, scope, topic: candidate.topic, title: candidate.title, reason: decision.reason, confidence: decision.confidence, history_written: false, pending_conflict: false }
    if (decision.relation === 'CONFLICT') {
      await this.writeConflict(scope, candidate, decision)
      return { relation: decision.relation, memory_id: target?.metadata.id, scope, topic: candidate.topic, title: candidate.title, reason: decision.reason, confidence: decision.confidence, history_written: false, pending_conflict: true }
    }
    if (decision.relation === 'NEW' || !target) {
      const block = this.newBlock(scope, candidate)
      await this.writeNewBlock(scope, block)
      return { relation: 'NEW', memory_id: block.metadata.id, scope, topic: block.topic, title: block.title, reason: decision.reason, confidence: decision.confidence, history_written: false, pending_conflict: false }
    }
    const updated = this.updatedBlock(target, candidate, decision)
    const historyWritten = await this.replaceBlock(scope, target, updated, decision.relation)
    return { relation: decision.relation, memory_id: updated.metadata.id, scope, topic: updated.topic, title: updated.title, reason: decision.reason, confidence: decision.confidence, history_written: historyWritten, pending_conflict: false }
  }

  private newBlock(scope: MemoryScope, candidate: MemoryCandidate): MemoryBlock {
    const timestamp = nowIso()
    const metadata: MemoryMetadata = {
      id: createMemoryId(), status: 'active', created_at: timestamp, updated_at: timestamp,
      source_session: candidate.sourceSession ?? this.sessionId, scope,
      ...(scope === 'workspace' ? { workspace_id: this.paths.workspaceId } : {}),
    }
    return { metadata, topic: candidate.topic, title: candidate.title, content: candidate.content, evidence: candidate.evidence ?? '' }
  }

  private updatedBlock(target: MemoryBlock, candidate: MemoryCandidate, decision: RelationDecision): MemoryBlock {
    const content = decision.relation === 'REFINE' ? decision.mergedContent ?? `${target.content}\n\n${candidate.content}` : candidate.content
    return { ...target, title: candidate.title || target.title, content, evidence: candidate.evidence ?? target.evidence, metadata: { ...target.metadata, updated_at: nowIso(), source_session: candidate.sourceSession ?? this.sessionId } }
  }

  private async writeNewBlock(scope: MemoryScope, block: MemoryBlock): Promise<void> {
    const dir = this.scopeDir(scope)
    const topicPath = ensureInside(dir, join(dir, `${safeTopicSlug(block.topic)}.md`))
    let blocks: MemoryBlock[] = []
    if (await this.exists(topicPath)) blocks = parseTopicFile(await readFile(topicPath, 'utf8'), topicPath).blocks
    if (blocks.some((item) => item.metadata.id === block.metadata.id)) throw new Error(`Duplicate memory_id: ${block.metadata.id}`)
    if (new Set((await this.topicFiles(scope)).map((file) => basename(file, '.md'))).size >= this.config.maxTopicCount && !await this.exists(topicPath)) throw new Error('Memory topic limit exceeded')
    blocks.push(block)
    const serialized = serializeTopicFile(block.topic, blocks)
    if (Buffer.byteLength(serializeMemoryBlock(block), 'utf8') > this.config.maxBlockBytes) throw new Error('Memory block exceeds size limit')
    await atomicWrite(topicPath, serialized)
    await this.rebuildIndexForScope(scope)
  }

  private async replaceBlock(scope: MemoryScope, oldBlock: MemoryBlock, newBlock: MemoryBlock, relation: 'UPDATE' | 'REFINE'): Promise<boolean> {
    const dir = this.scopeDir(scope)
    const topicPath = ensureInside(dir, oldBlock.filePath ?? join(dir, `${safeTopicSlug(oldBlock.topic)}.md`))
    const parsed = parseTopicFile(await readFile(topicPath, 'utf8'), topicPath)
    const index = parsed.blocks.findIndex((block) => block.metadata.id === oldBlock.metadata.id)
    if (index < 0) throw new Error(`Target memory disappeared during update: ${oldBlock.metadata.id}`)
    if (Buffer.byteLength(serializeMemoryBlock(newBlock), 'utf8') > this.config.maxBlockBytes) throw new Error('Memory block exceeds size limit')
    const historyWritten = this.config.historyEnabled && await this.writeHistory(scope, oldBlock, relation)
    parsed.blocks[index] = newBlock
    await atomicWrite(topicPath, serializeTopicFile(parsed.topic, parsed.blocks))
    await this.rebuildIndexForScope(scope)
    return historyWritten
  }

  private async writeHistory(scope: MemoryScope, block: MemoryBlock, relation: string): Promise<boolean> {
    const dir = this.scopeDir(scope)
    const historyPath = ensureInside(dir, join(dir, historyDirName, block.metadata.id, `${Date.now()}-${safeTopicSlug(relation)}.md`))
    const text = `# Historical Memory\n\nRelation: ${relation}\nArchived at: ${nowIso()}\n\n${serializeMemoryBlock(block)}`
    await atomicWrite(historyPath, text)
    return true
  }

  private async writeConflict(scope: MemoryScope, candidate: MemoryCandidate, decision: RelationDecision): Promise<void> {
    const path = ensureInside(this.scopeDir(scope), join(this.scopeDir(scope), conflictFileName))
    await appendFile(path, `${JSON.stringify({ candidate, decision, recorded_at: nowIso() })}\n`, 'utf8')
  }

  private async findById(memoryId: string): Promise<MemoryBlock | undefined> {
    for (const scope of ['workspace', 'global'] as const) {
      for (const block of await this.list(scope)) if (block.metadata.id === memoryId) return block
    }
    return undefined
  }

  private async readHistory(block: MemoryBlock): Promise<string[]> {
    const path = join(this.scopeDir(block.metadata.scope), historyDirName, block.metadata.id)
    try {
      const names = (await readdir(path)).filter((name) => name.endsWith('.md')).sort()
      return Promise.all(names.map(async (name) => clampText(await readFile(join(path, name), 'utf8'), this.config.maxOutputBytes)))
    } catch (error) {
      if (isMissing(error)) return []
      throw error
    }
  }

  private async topicFiles(scope: MemoryScope): Promise<string[]> {
    const dir = this.scopeDir(scope)
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name !== memoryFileName).map((entry) => ensureInside(dir, join(dir, entry.name))).sort()
  }

  private async rebuildIndexForScope(scope: MemoryScope): Promise<void> {
    const dir = this.scopeDir(scope)
    const files = await this.topicFiles(scope)
    const topics = [] as Array<{ name: string; file: string }>
    for (const file of files) {
      const parsed = parseTopicFile(await readFile(file, 'utf8'), file)
      if (parsed.blocks.some((block) => block.metadata.status === 'active')) topics.push({ name: parsed.topic, file: basename(file) })
    }
    topics.sort((a, b) => a.name.localeCompare(b.name))
    const lines = ['# Memory Index', '', ...topics.flatMap((topic) => [`- ${topic.name}`, `  Long-term memory for ${topic.name}.`, `  -> ${topic.file}`, ''])]
    await atomicWrite(join(dir, memoryFileName), `${lines.join('\n').trim()}\n`)
  }

  async rebuildIndex(scope?: MemoryScope): Promise<void> {
    this.assertInitialized()
    if (scope) { await this.rebuildIndexForScope(scope); return }
    await this.rebuildIndexForScope('workspace')
    await this.rebuildIndexForScope('global')
  }

  async indexText(scope: MemoryScope): Promise<string> {
    return readTextOrEmpty(join(this.scopeDir(scope), memoryFileName))
  }

  async advanceContextEpoch(): Promise<number> {
    return this.epoch.advance()
  }

  async archive(memoryId: string): Promise<MemoryBlock> {
    const block = await this.findById(memoryId)
    if (!block) throw new Error(`Memory not found: ${memoryId}`)
    return withFileLock(this.scopeLock(block.metadata.scope), block.metadata.scope, this.config.lockTimeoutMs, this.config.lockRetryMs, async () => {
      const path = block.filePath
      if (!path) throw new Error('Memory has no backing file')
      const parsed = parseTopicFile(await readFile(path, 'utf8'), path)
      const index = parsed.blocks.findIndex((item) => item.metadata.id === memoryId)
      if (index < 0) throw new Error(`Memory not found: ${memoryId}`)
       const existing = parsed.blocks[index]
       if (!existing) throw new Error(`Memory not found: ${memoryId}`)
       const archived: MemoryBlock = { ...existing, metadata: { ...existing.metadata, status: 'archived' as const, updated_at: nowIso() } }
       if (this.config.historyEnabled) await this.writeHistory(block.metadata.scope, existing, 'ARCHIVE')
      parsed.blocks[index] = archived
      await atomicWrite(path, serializeTopicFile(parsed.topic, parsed.blocks))
       await this.rebuildIndexForScope(block.metadata.scope)
      return archived
    })
  }

  async validate(): Promise<ValidationReport> {
    this.assertInitialized()
    const issues: ValidationIssue[] = []
    const seen = new Map<string, string>()
    let active = 0
    let archived = 0
    let topics = 0
    for (const scope of ['workspace', 'global'] as const) {
      const dir = this.scopeDir(scope)
      const files = await this.topicFiles(scope)
      topics += files.length
      for (const file of files) {
        try {
          const parsed = parseTopicFile(await readFile(file, 'utf8'), file)
          for (const block of parsed.blocks) {
            if (seen.has(block.metadata.id)) issues.push({ severity: 'error', scope, path: file, message: `Duplicate memory_id also found at ${seen.get(block.metadata.id)}` })
            seen.set(block.metadata.id, file)
            if (block.metadata.scope !== scope) issues.push({ severity: 'error', scope, path: file, message: `Metadata scope is ${block.metadata.scope}` })
            if (block.metadata.status === 'active') active += 1
            else archived += 1
          }
        } catch (error) {
          issues.push({ severity: 'error', scope, path: file, message: error instanceof Error ? error.message : String(error) })
        }
      }
      const indexText = await this.indexText(scope)
      for (const line of indexText.split(/\r?\n/u).filter((item) => item.includes('->'))) {
        const file = line.split('->')[1]?.trim()
        if (file && !(await this.exists(ensureInside(dir, join(dir, file))))) issues.push({ severity: 'error', scope, path: join(dir, memoryFileName), message: `Missing topic file ${file}` })
      }
    }
    return { ok: issues.every((issue) => issue.severity !== 'error'), issues, active_memories: active, archived_memories: archived, topics }
  }

  async stats(): Promise<StoreStats> {
    const report = await this.validate()
    return { workspace_id: this.paths.workspaceId, workspace_root: this.paths.workspaceRoot, memory_root: this.paths.memoryRoot, active_memories: report.active_memories, archived_memories: report.archived_memories, topics: report.topics }
  }

  private validateCandidate(candidate: MemoryCandidate): void {
    const serialized = `${candidate.topic}\n${candidate.title}\n${candidate.content}\n${candidate.evidence ?? ''}`
    if (Buffer.byteLength(serialized, 'utf8') > this.config.maxCandidateBytes) throw new Error('Memory candidate exceeds size limit')
    if (this.config.rejectSecrets && secretPatterns.some((pattern) => pattern.test(serialized))) throw new Error('Possible secret detected; memory rejected')
    if (candidate.topic.length > 120 || candidate.title.length > 240) throw new Error('Memory topic or title is too long')
    safeTopicSlug(candidate.topic)
  }
}
