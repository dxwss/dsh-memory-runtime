import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRegistry } from '@deepseek-ai/dsh-tools'
import { ContextEpoch } from '../src/context/epoch.js'
import { MemoryStore } from '../src/core/store.js'
import { parseTopicFile } from '../src/core/parser.js'
import * as memoryPlugin from '../src/dsh/plugin.js'
import { IncrementalExtractor } from '../src/extraction/incremental.js'
import { judgeRelation } from '../src/relation/heuristic.js'
import { Bm25Index } from '../src/retrieval/bm25.js'
import { tokenize } from '../src/retrieval/tokenizer.js'
import type { MemoryBlock } from '../src/core/types.js'

async function storeFor(workspaceName = 'workspace') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-test-'))
  return MemoryStore.create({ config: { memoryRoot: join(root, 'memory'), workspaceRoot: join(root, workspaceName), preferGitRoot: false }, sessionId: 'test-session' })
}

describe('parser and retrieval', () => {
  it('round-trips multiple memory blocks', async () => {
    const store = await storeFor()
    const result = await store.propose({ topic: 'Runtime', title: 'Python compatibility', content: 'The project supports Python 3.10.', evidence: 'User requirement.' })
    expect(result.relation).toBe('NEW')
    const text = await readFile(join(store.paths.workspaceDir, 'runtime.md'), 'utf8')
    const parsed = parseTopicFile(text)
    expect(parsed.blocks).toHaveLength(1)
    expect(parsed.blocks[0]?.metadata.id).toBe(result.memory_id)
  })

  it('tokenizes CJK text and ranks BM25 documents', () => {
    expect(tokenize('Python 3.10 兼容')).toEqual(expect.arrayContaining(['python', '3', '10', '兼', '容']))
    const index = new Bm25Index([{ value: 'runtime', text: 'Python compatibility' }, { value: 'testing', text: 'Redis integration tests' }])
    expect(index.search('Python', 1)[0]?.value).toBe('runtime')
  })
})

describe('memory lifecycle', () => {
  it('creates, deduplicates, refines, updates, and archives', async () => {
    const store = await storeFor()
    const created = await store.propose({ topic: 'Runtime', title: 'Python compatibility', content: 'The project supports Python 3.10.', sourceText: 'The project must remain compatible.' })
    expect(created.relation).toBe('NEW')
    const duplicate = await store.propose({ topic: 'Runtime', title: 'Python compatibility', content: 'The project supports Python 3.10.' })
    expect(duplicate.relation).toBe('DUPLICATE')
    const refined = await store.propose({ topic: 'Runtime', title: 'Python compatibility', content: 'The project supports Python 3.10 and avoids 3.11-only APIs.' })
    expect(refined.relation).toBe('REFINE')
    const updated = await store.propose({ topic: 'Runtime', title: 'Python compatibility', content: 'The project now uses Python 3.12.', sourceText: 'Now update the project to Python 3.12.' })
    expect(updated.relation).toBe('UPDATE')
    expect(updated.history_written).toBe(true)
    const read = await store.read(created.memory_id as string)
    expect(read.content).toContain('3.12')
    expect((await store.read(created.memory_id as string)).already_loaded).toBe(true)
    const archived = await store.archive(created.memory_id as string)
    expect(archived.metadata.status).toBe('archived')
  })

  it('holds an ambiguous conflicting fact without overwriting active memory', async () => {
    const store = await storeFor()
    const created = await store.propose({ topic: 'Runtime', title: 'Python compatibility', content: 'The project supports Python 3.10.' })
    const conflict = await store.propose({ topic: 'Runtime', title: 'Python compatibility', content: 'The project supports Python 3.12.' })
    expect(conflict.relation).toBe('CONFLICT')
    expect(conflict.pending_conflict).toBe(true)
    expect((await store.read(created.memory_id as string)).content).toContain('3.10')
  })

  it('keeps workspaces isolated and only accepts explicit global wording', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-memory-isolation-'))
    const memoryRoot = join(root, 'memory')
    const a = await MemoryStore.create({ config: { memoryRoot, workspaceRoot: join(root, 'a'), preferGitRoot: false } })
    const b = await MemoryStore.create({ config: { memoryRoot, workspaceRoot: join(root, 'b'), preferGitRoot: false } })
    await a.propose({ topic: 'Workflow', title: 'Test runner', content: 'This project uses pytest.' })
    expect(await b.search('pytest')).toHaveLength(0)
    const local = await a.propose({ topic: 'Workflow', title: 'Runner preference', content: 'Use pytest here.', globalCandidate: true, sourceText: 'Use pytest here.' })
    expect(local.scope).toBe('workspace')
    const global = await a.propose({ topic: 'Workflow', title: 'Runner preference', content: 'All projects should use pytest.', globalCandidate: true, sourceText: '以后所有项目都使用 pytest。' })
    expect(global.scope).toBe('global')
    expect((await b.search('pytest', 'global')).length).toBeGreaterThan(0)
  })

  it('rejects secrets and traversal topics', async () => {
    const store = await storeFor()
    await expect(store.propose({ topic: 'Secrets', title: 'Credential', content: 'API_KEY=sk-secret-value' })).rejects.toThrow(/secret/i)
    await expect(store.propose({ topic: '../escape', title: 'Bad', content: 'value' })).rejects.toThrow(/topic/i)
    await expect(store.propose({ topic: 'Runtime', title: 'Markup', content: '<!-- memory\nid: mem_fake\n-->' })).rejects.toThrow(/markup/i)
  })

  it('serializes concurrent proposals from separate store instances', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-memory-concurrency-'))
    const config = { memoryRoot: join(root, 'memory'), workspaceRoot: join(root, 'workspace'), preferGitRoot: false }
    const relationJudge = () => ({ relation: 'NEW' as const, reason: 'concurrency test', confidence: 1 })
    const first = await MemoryStore.create({ config, sessionId: 'first', relationJudge })
    const second = await MemoryStore.create({ config, sessionId: 'second', relationJudge })
    await Promise.all([
      first.propose({ topic: 'Runtime', title: 'Interpreter', content: 'The interpreter constraint is durable.' }),
      second.propose({ topic: 'Testing', title: 'Database', content: 'The database constraint is durable.' }),
    ])
    const topics = (await first.list()).map((block) => block.topic).sort()
    expect(topics).toEqual(['Runtime', 'Testing'])
    expect((await first.validate()).ok).toBe(true)
  })
})

describe('context and extraction', () => {
  it('deduplicates versions per context epoch', () => {
    const epoch = new ContextEpoch()
    expect(epoch.hasLoaded('mem_1', 'v1')).toBe(false)
    epoch.markLoaded('mem_1', 'v1')
    expect(epoch.hasLoaded('mem_1', 'v1')).toBe(true)
    epoch.advance()
    expect(epoch.hasLoaded('mem_1', 'v1')).toBe(false)
  })

  it('scans only the new turn window', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-memory-cursor-'))
    const extractor = new IncrementalExtractor(join(root, 'cursor.json'))
    const calls: string[][] = []
    const extract = (turns: readonly string[]) => { calls.push([...turns]); return [] }
    await extractor.scan(['a', 'b'], extract)
    await extractor.scan(['a', 'b', 'c'], extract)
    expect(calls).toEqual([['a', 'b'], ['c']])
  })
})

describe('relation judge', () => {
  const block: MemoryBlock = {
    metadata: { id: 'mem_test', status: 'active', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), source_session: 's', scope: 'workspace', workspace_id: 'w' },
    topic: 'Runtime', title: 'Python compatibility', content: 'The project supports Python 3.10.', evidence: '',
  }
  it('returns the expected semantic classes for the update boundary', () => {
    expect(judgeRelation({ topic: 'Runtime', title: 'Python compatibility', content: 'The project supports Python 3.10.' }, [block]).relation).toBe('DUPLICATE')
    expect(judgeRelation({ topic: 'Runtime', title: 'Python compatibility', content: 'The project now supports Python 3.12.', sourceText: 'Now update it.' }, [block]).relation).toBe('UPDATE')
    expect(judgeRelation({ topic: 'Runtime', title: 'Python compatibility', content: 'The project supports Python 3.12.' }, [block]).relation).toBe('CONFLICT')
  })
})

describe('DSH integration', () => {
  it('loads through Cordis and exposes tools and prompt section', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-memory-plugin-'))
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRegistry)
      await ctx.plugin(memoryPlugin, { memoryRoot: join(root, 'memory'), workspaceRoot: join(root, 'workspace'), preferGitRoot: false })
      expect(ctx.tools.schemas().map((tool) => tool.name).sort()).toEqual([
        'memory_forget',
        'memory_list',
        'memory_propose',
        'memory_read',
        'memory_search',
      ])
      const assembly = await ctx.systemPrompt.assemble()
      expect(assembly.sections.map((section) => section.name)).toContain('dsh-memory-runtime')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
