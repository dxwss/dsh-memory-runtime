import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { isStale } from './utils.js'

const processLocks = new Map<string, Promise<void>>()

async function acquireDirectory(path: string, timeoutMs: number, retryMs: number): Promise<() => Promise<void>> {
  const started = Date.now()
  const token = randomBytes(8).toString('hex')
  while (true) {
    try {
      await mkdir(path)
      await BunSafeWrite(join(path, 'owner'), `${process.pid}:${token}`)
      return async () => {
        await rm(path, { recursive: true, force: true })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (await isStale(path, Math.max(timeoutMs * 2, 30_000))) {
        await rm(path, { recursive: true, force: true }).catch(() => undefined)
        continue
      }
      if (Date.now() - started >= timeoutMs) throw new Error(`Timed out waiting for memory lock: ${path}`)
      await new Promise((resolve) => setTimeout(resolve, retryMs))
    }
  }
}

async function BunSafeWrite(path: string, content: string): Promise<void> {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(path, content, 'utf8')
}

export async function withFileLock<T>(
  lockRoot: string,
  key: string,
  timeoutMs: number,
  retryMs: number,
  task: () => Promise<T>,
): Promise<T> {
  const prior = processLocks.get(lockRoot)
  let releaseProcess: (() => void) | undefined
  const processTurn = new Promise<void>((resolve) => { releaseProcess = resolve })
  const queued = prior ? prior.then(() => processTurn) : processTurn
  processLocks.set(lockRoot, queued)
  await prior
  const releaseFile = await acquireDirectory(lockRoot, timeoutMs, retryMs)
  try {
    return await task()
  } finally {
    await releaseFile()
    releaseProcess?.()
    if (processLocks.get(lockRoot) === queued) processLocks.delete(lockRoot)
  }
}
