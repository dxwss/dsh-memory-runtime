#!/usr/bin/env node
import { MemoryStore } from './core/store.js'

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'stats'
  const store = await MemoryStore.create()
  if (command === 'validate') {
    console.log(JSON.stringify(await store.validate(), null, 2))
    return
  }
  if (command === 'rebuild-index') {
    await store.rebuildIndex()
    console.log(JSON.stringify({ ok: true, workspace: store.paths.workspaceDir, global: store.paths.globalDir }, null, 2))
    return
  }
  if (command === 'scan-duplicates') {
    const blocks = await store.list('workspace')
    const duplicates = blocks.filter((left, index) => blocks.some((right, rightIndex) => rightIndex < index && left.title.toLocaleLowerCase() === right.title.toLocaleLowerCase() && left.content.toLocaleLowerCase() === right.content.toLocaleLowerCase()))
    console.log(JSON.stringify({ duplicates: duplicates.map((block) => block.metadata.id) }, null, 2))
    return
  }
  console.log(JSON.stringify(await store.stats(), null, 2))
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
