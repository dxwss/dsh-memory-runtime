import { sha256 } from '../core/utils.js'

export class ContextEpoch {
  private currentEpoch = 0
  private readonly loadedVersions = new Map<string, string>()
  private readonly indexDigests = new Map<string, string>()

  get epoch(): number { return this.currentEpoch }

  hasLoaded(memoryId: string, versionHash: string): boolean {
    return this.loadedVersions.get(memoryId) === versionHash
  }

  markLoaded(memoryId: string, versionHash: string): void {
    this.loadedVersions.set(memoryId, versionHash)
  }

  advance(): number {
    this.currentEpoch += 1
    this.loadedVersions.clear()
    this.indexDigests.clear()
    return this.currentEpoch
  }

  shouldInjectIndex(scope: string, text: string): boolean {
    const digest = sha256(text)
    if (this.indexDigests.get(scope) === digest) return false
    this.indexDigests.set(scope, digest)
    return true
  }

  reset(): void {
    this.currentEpoch = 0
    this.loadedVersions.clear()
    this.indexDigests.clear()
  }
}
