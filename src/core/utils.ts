import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'

export function nowIso(): string {
  return new Date().toISOString()
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function createMemoryId(): string {
  const timestamp = Date.now().toString(36).padStart(9, '0')
  return `mem_${timestamp}_${randomBytes(8).toString('hex')}`
}

export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

export function normalizeKey(value: string): string {
  return normalizeWhitespace(value).toLocaleLowerCase()
}

export function safeTopicSlug(topic: string): string {
  const source = topic.normalize('NFKC').trim()
  if (!source || /[\\/\u0000-\u001f\u007f]/u.test(source)) {
    throw new Error('Invalid topic: a non-empty safe topic name is required')
  }
  const normalized = normalizeWhitespace(source)
    .replace(/[^\p{L}\p{N}._ -]/gu, '')
    .trim()
    .replace(/[ .]+/gu, '-')
    .replace(/-+/gu, '-')
    .toLocaleLowerCase()
  if (!normalized || normalized === '.' || normalized === '..' || normalized.includes('..')) {
    throw new Error('Invalid topic: a non-empty safe topic name is required')
  }
  return normalized.slice(0, 80)
}

export function ensureInside(root: string, target: string): string {
  const rootAbs = resolve(root)
  const targetAbs = resolve(target)
  const rel = relative(rootAbs, targetAbs)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('Path escapes memory root')
  }
  return targetAbs
}

export async function atomicWrite(path: string, content: string): Promise<void> {
  const parent = dirname(path)
  await mkdir(parent, { recursive: true })
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(5).toString('hex')}`
  const handle = await open(temporary, 'wx')
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

export async function readTextOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (isMissing(error)) return ''
    throw error
  }
}

export function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

export async function findGitRoot(start: string): Promise<string | undefined> {
  let current = resolve(start)
  while (true) {
    if (existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

export async function isStale(path: string, ageMs: number): Promise<boolean> {
  try {
    const info = await stat(path)
    return Date.now() - info.mtimeMs > ageMs
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

export function clampText(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  let result = value
  while (Buffer.byteLength(result, 'utf8') > maxBytes - 32) {
    result = result.slice(0, Math.max(0, result.length - Math.ceil(result.length / 10)))
  }
  return `${result}\n\n[truncated]`
}
