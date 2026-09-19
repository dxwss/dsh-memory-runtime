const latinToken = /[\p{L}\p{N}_-]+/gu
const cjk = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu

export function tokenize(text: string): string[] {
  const normalized = text.normalize('NFKC').toLocaleLowerCase()
  const tokens: string[] = normalized.match(latinToken) ?? []
  for (const sequence of normalized.match(cjk) ?? []) tokens.push(sequence)
  return tokens
}
