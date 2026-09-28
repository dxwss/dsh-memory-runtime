import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { CandidateExtractor } from '../core/types.js'

interface CursorDocument { lastTurn: number }

export class IncrementalExtractor {
  private lastTurn = 0
  private loaded = false

  constructor(private readonly cursorPath: string) {}

  private async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = await readFile(this.cursorPath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<CursorDocument>
      if (typeof parsed.lastTurn === 'number' && Number.isInteger(parsed.lastTurn) && parsed.lastTurn >= 0) this.lastTurn = parsed.lastTurn
    } catch { /* a missing or corrupt cursor safely starts from zero */ }
  }

  async scan(turns: readonly string[], extractor: CandidateExtractor, force = false) {
    await this.load()
    if (!force && turns.length <= this.lastTurn) return []
    const start = Math.min(this.lastTurn, turns.length)
    const window = turns.slice(start)
    const candidates = await extractor(window)
    this.lastTurn = turns.length
    await mkdir(dirname(this.cursorPath), { recursive: true })
    await writeFile(this.cursorPath, `${JSON.stringify({ lastTurn: this.lastTurn }, null, 2)}\n`, 'utf8')
    return candidates
  }

  async due(turnCount: number, interval: number): Promise<boolean> {
    await this.load()
    const normalizedInterval = Number.isInteger(interval) && interval > 0 ? interval : 10
    return turnCount >= this.lastTurn + normalizedInterval
  }

  async sessionEnd(turns: readonly string[], extractor: CandidateExtractor) {
    return this.scan(turns, extractor, true)
  }

  get cursor(): number { return this.lastTurn }
}
