import type { MemoryBlock, MemoryMetadata, MemoryScope } from './types.js'
import { normalizeWhitespace } from './utils.js'

const marker = /<!--\s*memory\s*\r?\n([\s\S]*?)\r?\n\s*-->/giu

export interface ParsedTopicFile {
  topic: string
  blocks: MemoryBlock[]
}

function parseMetadata(raw: string, filePath?: string): MemoryMetadata {
  const values = new Map<string, string>()
  for (const line of raw.split(/\r?\n/u)) {
    const match = /^\s*([a-z_]+)\s*:\s*(.*?)\s*$/u.exec(line)
    if (!match || !match[1] || match[2] === undefined) continue
    values.set(match[1], match[2].replace(/^['"]|['"]$/gu, ''))
  }
  const id = values.get('id')
  const status = values.get('status')
  const createdAt = values.get('created_at')
  const updatedAt = values.get('updated_at')
  const sourceSession = values.get('source_session')
  const scope = values.get('scope') as MemoryScope | undefined
  if (!id || !/^mem_[a-z0-9_-]+$/iu.test(id)) throw new Error(`Malformed memory id in ${filePath ?? 'topic file'}`)
  if (status !== 'active' && status !== 'archived') throw new Error(`Malformed memory status for ${id}`)
  if (!createdAt || Number.isNaN(Date.parse(createdAt))) throw new Error(`Malformed created_at for ${id}`)
  if (!updatedAt || Number.isNaN(Date.parse(updatedAt))) throw new Error(`Malformed updated_at for ${id}`)
  if (!sourceSession) throw new Error(`Missing source_session for ${id}`)
  if (scope !== 'workspace' && scope !== 'global') throw new Error(`Malformed scope for ${id}`)
  const workspaceId = values.get('workspace_id')
  if (scope === 'workspace' && !workspaceId) throw new Error(`Missing workspace_id for ${id}`)
  return { id, status, created_at: createdAt, updated_at: updatedAt, source_session: sourceSession, scope, ...(workspaceId ? { workspace_id: workspaceId } : {}) }
}

function sectionAfterHeading(text: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const match = new RegExp(`^###\\s+${escaped}\\s*$([\\s\\S]*?)(?=^###\\s+|$)`, 'imu').exec(text)
  return normalizeWhitespace(match?.[1] ?? '')
}

export function parseTopicFile(text: string, filePath?: string): ParsedTopicFile {
  const heading = /^#\s+(.+?)\s*$/mu.exec(text)?.[1]?.trim()
  if (!heading) throw new Error(`Topic file has no H1 heading: ${filePath ?? 'topic file'}`)
  const matches = [...text.matchAll(marker)]
  const blocks: MemoryBlock[] = []
  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index]
    if (!current || current.index === undefined || !current[1]) continue
    const bodyStart = current.index + current[0].length
    const nextStart = matches[index + 1]?.index ?? text.length
    const body = text.slice(bodyStart, nextStart).trim()
    const titleLine = /^##[ \t]+([^\r\n]+?)[ \t]*(?:\r?\n|$)/u.exec(body)
    const title = titleLine?.[1]?.trim()
    if (!title || !titleLine) throw new Error(`Memory block has no H2 title in ${filePath ?? 'topic file'}`)
    const withoutTitle = body.slice(titleLine[0].length).trim()
    const evidence = sectionAfterHeading(withoutTitle, 'Evidence')
    const content = withoutTitle.replace(/^###\s+Evidence\s*$[\s\S]*$/imu, '').trim()
    const metadata = parseMetadata(current[1], filePath)
    blocks.push({ metadata, topic: heading, title, content, evidence, filePath })
  }
  return { topic: heading, blocks }
}

export function serializeMemoryBlock(block: MemoryBlock): string {
  const m = block.metadata
  const lines = [
    '<!-- memory',
    `id: ${m.id}`,
    `status: ${m.status}`,
    `created_at: ${m.created_at}`,
    `updated_at: ${m.updated_at}`,
    `source_session: ${m.source_session}`,
    `scope: ${m.scope}`,
    ...(m.workspace_id ? [`workspace_id: ${m.workspace_id}`] : []),
    '-->',
    '',
    `## ${block.title}`,
    '',
    block.content.trim(),
  ]
  if (block.evidence.trim()) lines.push('', '### Evidence', '', block.evidence.trim())
  return `${lines.join('\n').trim()}\n`
}

export function serializeTopicFile(topic: string, blocks: MemoryBlock[]): string {
  return `# ${topic.trim()}\n\n${blocks.map(serializeMemoryBlock).join('\n')}`
}
