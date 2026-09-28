import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { IncrementalExtractor } from '../extraction/incremental.js'
import type { MemoryStore } from '../core/store.js'
import type { CandidateExtractor } from '../core/types.js'

export interface SessionIntegrationConfig {
  getStore(session: Session, agent?: Agent): Promise<MemoryStore>
  getExtractor(session: Session, agent?: Agent): CandidateExtractor | undefined
  extractIntervalTurns: number
  onMemoryChanged(store: MemoryStore): void
}

function transcript(session: Session): string[] {
  const turns: string[] = []
  let current: string[] = []
  for (const event of session.snapshotEvents()) {
    if (event.type === 'turn/start') current = []
    else if (event.type === 'user/message' && event.data.source.kind === 'user' && event.surfaceOp === 'append') {
      const text = event.data.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
      if (text) current.push(`User: ${text}`)
    } else if (event.type === 'assistant/message' && event.surfaceOp === 'append') {
      const text = event.data.message.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
      if (text) current.push(`Assistant: ${text}`)
    } else if (event.type === 'turn/end' && current.length > 0) {
      turns.push(current.join('\n'))
      current = []
    }
  }
  return turns
}

export function installSessionIntegration(ctx: Context, config: SessionIntegrationConfig): void {
  const pending = new Map<Session, Promise<void>>()
  const agents = new WeakMap<Session, Agent>()

  function schedule(session: Session, force = false): void {
    const agent = agents.get(session)
    const extractor = config.getExtractor(session, agent)
    if (!extractor) return
    const previous = pending.get(session) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(async () => {
      const store = await config.getStore(session, agent)
      const turns = transcript(session)
      const cursor = new IncrementalExtractor(join(store.storagePaths.workspaceDir, '.cursors', `${encodeURIComponent(session.id)}.json`))
      if (!force && !await cursor.due(turns.length, config.extractIntervalTurns)) return
      const candidates = await cursor.scan(turns, extractor, force)
      for (const candidate of candidates) {
        await store.propose({ ...candidate, sourceSession: session.id })
      }
      if (candidates.length > 0) config.onMemoryChanged(store)
    }).catch((error: unknown) => {
      ctx.logger.warn(`memory extraction for session ${session.id} failed: ${String(error)}`)
    })
    pending.set(session, next)
    void next.finally(() => { if (pending.get(session) === next) pending.delete(session) })
  }

  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/end') schedule(session)
    if (event.type === 'user/message' && event.surfaceOp && event.surfaceOp !== 'append') {
      void config.getStore(session, agents.get(session)).then((store) => store.advanceContextEpoch()).catch((error: unknown) => {
        ctx.logger.warn(`memory context reset failed: ${String(error)}`)
      })
    }
  }, { global: true })

  ctx.on('session/disposed', (session) => {
    schedule(session, true)
  }, { global: true })

  ctx.on('agent/session-start', ({ agent, source }: { agent: Agent; source: string }) => {
    agents.set(agent.session, agent)
    void config.getStore(agent.session, agent).catch((error: unknown) => {
      ctx.logger.warn(`memory store initialization failed: ${String(error)}`)
    })
    if (source === 'compact' || source === 'clear') {
      void config.getStore(agent.session, agent).then((store) => store.advanceContextEpoch()).catch((error: unknown) => {
        ctx.logger.warn(`memory context reset failed: ${String(error)}`)
      })
    }
  }, { global: true })

  ctx.on('session/flush', async (session) => {
    await pending.get(session)
  }, { global: true })
}
