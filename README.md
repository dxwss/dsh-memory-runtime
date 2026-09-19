# dsh-memory-runtime

An auditable, workspace-scoped long-term memory runtime for DeepSeek Harness (DSH).
Markdown files are the source of truth; runtime indexes are rebuilt from them.

## Features

- Workspace-isolated and explicitly opt-in global memory.
- Stable `memory_id` values and human-readable topic Markdown files.
- Topic-first BM25 retrieval with basic CJK tokenization.
- `NEW`, `DUPLICATE`, `REFINE`, `UPDATE`, and `CONFLICT` decisions.
- History snapshots for updates and archives.
- Atomic writes, per-scope cross-process directory locks, and validation.
- Secret and prompt-injection checks, bounded candidate/output sizes, and path traversal protection.
- Context-epoch and version-hash based read de-duplication.
- Native DSH tools and a dynamic system-prompt section.

## Requirements

- Node.js `>=22.19.0` (the current DSH requirement).
- npm.

The repository can be typechecked and tested on older Node versions when the
installed dependencies support them, but production DSH loading should use the
declared engine version.

## Install

Install from npm when published:

```sh
npm install dsh-memory-runtime
```

Then add the bundled plugin to a DSH profile:

```sh
dsh --patch ./node_modules/dsh-memory-runtime/cordis.patch.yml
```

The package metadata also exposes the patch through `dsh.bundle.patch` for
loaders that read package metadata.

For local development:

```sh
npm install
npm run typecheck
npm test
npm run build
```

## Quick Start

The runtime registers these tools:

| Tool | Purpose |
| --- | --- |
| `memory_search` | Search active memory summaries in the workspace or explicit global scope. |
| `memory_read` | Read one block by stable `memory_id`, with context-aware de-duplication. |
| `memory_propose` | Submit a durable candidate for relation judgment and persistence. |
| `memory_list` | Inspect blocks by scope and optional topic. |
| `memory_forget` | Archive a block without deleting its history. |

The agent should propose reusable facts, constraints, preferences, and debugging
knowledge. It should not store credentials, one-off task details, raw external
instructions, or prompt-injection text.

## Storage Layout

By default, data is stored under `$DSH_HOME/memory-runtime`:

```text
memory-runtime/
├─ global/
│  ├─ MEMORY.md
│  └─ <topic>.md
└─ workspaces/<workspace_id>/
   ├─ MEMORY.md
   ├─ <topic>.md
   ├─ .history/<memory_id>/*.md
   ├─ pending-conflicts.jsonl
   └─ traces.jsonl
```

Set `DSH_MEMORY_ROOT` or pass `memoryRoot` in plugin configuration to choose a
different root. Workspace identity is derived from the configured workspace,
the Git root when enabled, or the current directory.

Each topic file contains Markdown memory blocks with metadata such as
`memory_id`, status, timestamps, source session, scope, and workspace ID. The
topic files are the fact source; `MEMORY.md` is a derived lightweight index.

## Configuration

The plugin accepts the runtime configuration directly, or nested under
`memory`:

```yaml
memory:
  memoryRoot: ~/.dsh/memory-runtime
  preferGitRoot: true
  historyEnabled: true
  searchTopK: 5
  maxBlockBytes: 32768
  maxTopicCount: 64
  maxCandidateBytes: 32768
  maxOutputBytes: 64000
  rejectSecrets: true
  rejectPromptInjection: true
  requireExplicitGlobalSignal: true
  minConfidenceForAutoUpdate: 0.8
  lockTimeoutMs: 10000
  lockRetryMs: 40
  deduplicateReads: true
```

Workspace scope is the default. A candidate can request global scope, but the
runtime only accepts it when the candidate's source text contains an explicit
cross-project signal such as `all projects`, `所有项目`, or `全局`.

## Relation Handling

The current relation judge is deterministic and conservative:

- `NEW` creates a new block.
- `DUPLICATE` is a no-op.
- `REFINE` merges new detail into the active block.
- `UPDATE` replaces the active content and writes the old block to history.
- `CONFLICT` preserves the active block and appends a reviewable record to
  `pending-conflicts.jsonl`.

The relation judge is injected through `MemoryStore.create({ relationJudge })`,
so an application can supply an LLM-backed judge while retaining the same
runtime safety and persistence boundary. The bundled DSH plugin uses the
deterministic fallback and does not make hidden model calls during writes.

## CLI

After building, the package exposes `memory-runtime`:

```sh
memory-runtime validate
memory-runtime rebuild-index
memory-runtime scan-duplicates
memory-runtime
```

The commands operate on the default configured store. `validate` checks parsed
topic files, duplicate IDs, scope metadata, and index references.

## Testing

```sh
npm run typecheck
npm test
npm run build
```

The test suite covers Markdown round trips, BM25/CJK retrieval, lifecycle
relations, history, workspace isolation, explicit global scope, safety checks,
context de-duplication, incremental extraction, and the Cordis plugin contract.

## Limitations and Roadmap

The v0.1 runtime deliberately keeps the relation judge local and deterministic;
LLM extraction hooks and a review UI are extension points, not implicit network
calls. Incremental extraction is provided as a cursor-based library, while DSH
session-end hook wiring depends on the host's session API and is not guessed by
this package. Crash safety is based on fsync plus atomic rename and recoverable
history; filesystem behavior should still be exercised on the target platform.

Future work can add an optional DSH LLM-backed judge, session lifecycle wiring,
duplicate suggestions, and a richer maintenance command set without changing
the Markdown contract.

## License

MIT
