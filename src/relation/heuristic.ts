import type { MemoryBlock, MemoryCandidate, RelationDecision } from '../core/types.js'
import { normalizeKey, normalizeWhitespace } from '../core/utils.js'
import { tokenize } from '../retrieval/tokenizer.js'

const updateWords = /\b(?:now|currently|switch(?:ed)?|migrat(?:e|ed)|updat(?:e|ed)|change(?:d)?|replace(?:d)?)\b|现在|目前|改为|改成|升级|切换|使用/u
const sensitiveInstruction = /ignore\s+(?:all\s+)?(?:previous|earlier|preceding)\s+instructions?|忽略(?:之前|上面|先前)的(?:所有)?指令/u
const memoryMarkup = /<!--\s*memory\b|-->/iu

function tokenSet(value: string): Set<string> {
  return new Set(tokenize(value))
}

function overlap(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0
  let common = 0
  for (const item of left) if (right.has(item)) common += 1
  return common / Math.max(1, Math.min(left.size, right.size))
}

function versions(value: string): string[] {
  return value.match(/\b\d+(?:\.\d+){1,3}\b/gu) ?? []
}

function hasContradictoryFact(oldContent: string, newContent: string): boolean {
  const oldVersions = versions(oldContent)
  const newVersions = versions(newContent)
  if (oldVersions.length > 0 && newVersions.length > 0 && oldVersions.some((item) => !newVersions.includes(item))) return true
  const oldLower = normalizeKey(oldContent)
  const newLower = normalizeKey(newContent)
  const oldNegated = /\b(?:not|never|cannot|must not)\b|不允许|不能|不要/u.test(oldLower)
  const newNegated = /\b(?:not|never|cannot|must not)\b|不允许|不能|不要/u.test(newLower)
  return oldNegated !== newNegated && overlap(tokenSet(oldContent), tokenSet(newContent)) >= 0.25
}

function explicitUpdate(candidate: MemoryCandidate): boolean {
  return updateWords.test(`${candidate.sourceText ?? ''} ${candidate.content}`)
}

function mergeContent(oldContent: string, newContent: string): string {
  if (!oldContent.trim()) return newContent.trim()
  if (!newContent.trim()) return oldContent.trim()
  if (normalizeKey(oldContent) === normalizeKey(newContent)) return oldContent.trim()
  return `${oldContent.trim()}\n\n${newContent.trim()}`
}

export function judgeRelation(candidate: MemoryCandidate, existing: MemoryBlock[]): RelationDecision {
  if (existing.length === 0) return { relation: 'NEW', reason: 'No active memory matched the candidate.', confidence: 0.76 }
  const candidateSubject = `${candidate.topic} ${candidate.title}`
  const candidateTokens = tokenSet(candidateSubject)
  let best: { block: MemoryBlock; subjectOverlap: number; bodyOverlap: number } | undefined
  for (const block of existing) {
    const subjectOverlap = overlap(candidateTokens, tokenSet(`${block.topic} ${block.title}`))
    const bodyOverlap = overlap(tokenSet(candidate.content), tokenSet(block.content))
    if (!best || subjectOverlap + bodyOverlap > best.subjectOverlap + best.bodyOverlap) best = { block, subjectOverlap, bodyOverlap }
  }
  if (!best) return { relation: 'NEW', reason: 'No comparable memory was found.', confidence: 0.76 }
  const { block, subjectOverlap, bodyOverlap } = best
  if (normalizeKey(candidate.content) === normalizeKey(block.content) && normalizeKey(candidate.title) === normalizeKey(block.title)) {
    return { relation: 'DUPLICATE', targetMemoryId: block.metadata.id, reason: 'The candidate matches the active memory.', confidence: 0.99 }
  }
  const sameSubject = subjectOverlap >= 0.34 || normalizeKey(candidate.title) === normalizeKey(block.title)
  if (!sameSubject) return { relation: 'NEW', reason: 'The candidate describes a different subject.', confidence: 0.78 }
  if (hasContradictoryFact(block.content, candidate.content)) {
    if (explicitUpdate(candidate)) {
      return { relation: 'UPDATE', targetMemoryId: block.metadata.id, reason: 'The candidate explicitly states the newer current fact.', confidence: 0.93 }
    }
    return { relation: 'CONFLICT', targetMemoryId: block.metadata.id, reason: 'The candidate conflicts with the active fact without a clear update signal.', confidence: 0.88 }
  }
  if (bodyOverlap >= 0.45 || normalizeKey(candidate.content).includes(normalizeKey(block.content))) {
    return { relation: 'REFINE', targetMemoryId: block.metadata.id, mergedContent: mergeContent(block.content, candidate.content), reason: 'The candidate preserves the existing fact and adds detail.', confidence: 0.89 }
  }
  if (explicitUpdate(candidate) || subjectOverlap >= 0.7) {
    return { relation: 'UPDATE', targetMemoryId: block.metadata.id, reason: 'The candidate describes the current state of the same subject.', confidence: 0.84 }
  }
  return { relation: 'CONFLICT', targetMemoryId: block.metadata.id, reason: 'The candidate is related but its relationship to the active memory is unclear.', confidence: 0.8 }
}

export function normalizeCandidate(candidate: MemoryCandidate): MemoryCandidate {
  const topic = normalizeWhitespace(candidate.topic)
  const title = normalizeWhitespace(candidate.title)
  const content = candidate.content.trim()
  if (!topic || !title || !content) throw new Error('topic, title, and content are required')
  if (sensitiveInstruction.test(content) || sensitiveInstruction.test(candidate.sourceText ?? '')) {
    throw new Error('Prompt-injection-like instructions cannot be stored as memory')
  }
  const serialized = [topic, title, content, candidate.evidence ?? '', candidate.sourceText ?? ''].join('\n')
  if (memoryMarkup.test(serialized)) throw new Error('Memory markup cannot be stored as memory')
  return {
    topic,
    title,
    content,
    ...(candidate.evidence?.trim() ? { evidence: candidate.evidence.trim() } : {}),
    ...(candidate.sourceSession?.trim() ? { sourceSession: candidate.sourceSession.trim() } : {}),
    ...(candidate.sourceText?.trim() ? { sourceText: candidate.sourceText.trim() } : {}),
    ...(candidate.globalCandidate ? { globalCandidate: true } : {}),
  }
}
