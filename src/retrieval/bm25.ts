import { tokenize } from './tokenizer.js'

export interface Bm25Document<T> { value: T; text: string }

export class Bm25Index<T> {
  private readonly documents: Array<{ value: T; tokens: string[] }>
  private readonly averageLength: number
  private readonly documentFrequency: Map<string, number>
  private readonly k1: number
  private readonly b: number

  constructor(documents: Bm25Document<T>[], k1 = 1.2, b = 0.75) {
    this.documents = documents.map(({ value, text }) => ({ value, tokens: tokenize(text) }))
    this.k1 = k1
    this.b = b
    this.documentFrequency = new Map()
    for (const document of this.documents) {
      for (const token of new Set(document.tokens)) this.documentFrequency.set(token, (this.documentFrequency.get(token) ?? 0) + 1)
    }
    this.averageLength = this.documents.length === 0 ? 1 : this.documents.reduce((sum, d) => sum + d.tokens.length, 0) / this.documents.length
  }

  search(query: string, limit: number): Array<{ value: T; score: number }> {
    const queryTokens = tokenize(query)
    const n = this.documents.length
    if (n === 0 || queryTokens.length === 0) return []
    const scored = this.documents.map((document) => {
      const counts = new Map<string, number>()
      for (const token of document.tokens) counts.set(token, (counts.get(token) ?? 0) + 1)
      let score = 0
      for (const token of queryTokens) {
        const df = this.documentFrequency.get(token) ?? 0
        if (!df) continue
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5))
        const tf = counts.get(token) ?? 0
        const denominator = tf + this.k1 * (1 - this.b + this.b * document.tokens.length / this.averageLength)
        score += idf * (tf * (this.k1 + 1)) / (denominator || 1)
      }
      return { value: document.value, score }
    })
    return scored.filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, Math.max(0, limit))
  }
}
