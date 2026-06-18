# PGlite to SQLite Replacement Plan for the Local Agent

## Goal

Replace the local `@grepmind/agent` storage layer from PGlite/PostgreSQL dialect to SQLite.

This is a storage reset, not a data migration. Existing PGlite data directories are not copied into SQLite. Users with old local data must re-register workspaces and sync again.

The target state:

- the agent opens a SQLite database at `<dataDir>/db/agent.sqlite`;
- SQLite migrations are applied from embedded package migrations;
- the runtime keeps the same RPC/API surface;
- local registration, sync, import, status, cleanup, and search workflows work on the new empty SQLite store;
- PGlite is no longer required for normal operation.

## Scope

In scope:

- `packages/agent` runtime, repositories, schema, migrations, package metadata, and README;
- generated embedded migrations;
- replacement of raw SQL currently executed through `PGlite.query`;
- replacement of pgvector-dependent search with a SQLite-compatible implementation;
- explicit handling of existing PGlite data directories as unsupported legacy state.

Out of scope:

- copying old PGlite data into SQLite;
- server/deployment PostgreSQL in `packages/deployment` and `packages/grepmind/src/deploy.ts`;
- backend database changes;
- public MCP protocol changes.

## Constraints

- Do not run `test` or `tsc` as verification.
- Use build commands when a new code version must be verified.
- Run `npm install` for SQLite dependencies only after explicit permission.
- Do not edit changeset files manually. If a changeset is needed, generate it through an npm script.
- Do not use `git reset`, `git push`, `git checkout`, or `git rebase`.

## Current PGlite Coupling

Main local-agent references:

- `packages/agent/package.json`
  - `@electric-sql/pglite` dependency;
  - description says PGlite.
- `packages/agent/src/runtime/agent-runtime.ts`
  - creates `PGlite`;
  - loads `@electric-sql/pglite/vector`;
  - runs `CREATE EXTENSION IF NOT EXISTS vector`;
  - uses `drizzle-orm/pglite/migrator`;
  - creates `LocalPgliteSearchService`.
- `packages/agent/src/db/schema.ts`
  - `AgentDb = PGlite`.
- `packages/agent/src/repositories/database.ts`
  - imports from `drizzle-orm/pglite`.
- `packages/agent/src/repositories/models/*.ts`
  - use `drizzle-orm/pg-core`;
  - use PostgreSQL `boolean`, `bigint`, and custom `vector`.
- `packages/agent/src/services/local-pglite-search-service.ts`
  - uses `embedding <=> CAST($3 AS vector)`.
- `packages/agent/src/services/artifact-import-service.ts`
  - inserts `CAST($7 AS vector)`.
- raw SQL call sites:
  - `packages/agent/src/services/artifact-import-service.ts`;
  - `packages/agent/src/services/project-sync/local-state.ts`;
  - `packages/agent/src/services/project-sync/revision-delta.ts`;
  - `packages/agent/src/services/project-sync/invalidations.ts`;
  - `packages/agent/src/services/project-sync/sync-state.ts`;
  - `packages/agent/src/runtime/rpc/idempotency-store.ts`;
  - `packages/agent/src/commands/status-query.ts`;
  - local search service.
- `packages/agent/drizzle.config.ts`
  - `dialect: 'postgresql'`.
- `packages/agent/drizzle/**` and `packages/agent/src/generated/agent-migrations.ts`
  - PostgreSQL migrations, snapshots, and journal metadata.
- `packages/agent/tsconfig.types.json`
  - PGlite vector path workaround.
- `packages/agent/README.md`
  - PGlite storage note.

## Key Decisions

### Driver

Use `better-sqlite3` unless engine policy blocks it.

Important dependency decision:

- current `@grepmind/agent` engine is `node >=18.0.0`;
- current `better-sqlite3@12` requires Node 20+;
- either pin a compatible `better-sqlite3` major or raise the package engine to Node 20+.

Dependency changes:

- add `better-sqlite3`;
- add `@types/better-sqlite3` if required;
- remove `@electric-sql/pglite`.

### SQLite Location

Use:

```text
<dataDir>/db/agent.sqlite
```

SQLite sidecar files:

```text
<dataDir>/db/agent.sqlite-wal
<dataDir>/db/agent.sqlite-shm
```

Reasons:

- preserves the existing `<dataDir>/db` database area;
- avoids mixing DB files with `agent-config.json`, pid, socket, and meta files;
- keeps old PGlite markers easy to detect.

### Existing PGlite Data

No automatic migration.

Detect old PGlite state:

```text
legacy root: <dataDir>/PG_VERSION
legacy nested: <dataDir>/db/PG_VERSION
new sqlite: <dataDir>/db/agent.sqlite
```

Recommended behavior:

1. If SQLite exists, open SQLite.
2. If SQLite is missing and no legacy PGlite marker exists, create a fresh SQLite DB.
3. If SQLite is missing and a legacy PGlite marker exists, fail fast with a clear error:
   - old local PGlite data is unsupported by this version;
   - no data was deleted;
   - user must run/reset the local data directory intentionally, then register and sync again.

Do not silently create a fresh SQLite DB over old PGlite state. Silent reset makes local project registrations appear lost without an explicit user action.

### Embedding Storage

Store embeddings as BLOB:

```text
embedding BLOB NOT NULL
```

Encoding:

- `Float32Array` little-endian bytes;
- `encodeEmbedding(vector: number[]): Buffer`;
- `decodeEmbedding(buffer: Buffer): number[]`, or compute distance directly from bytes;
- keep dimension validation in `ArtifactImportService`.

### Vector Search

Do not add a native SQLite vector extension in the first replacement.

MVP:

1. SQL selects candidates by `binding_id`, `revision_id`, optional path filter, and docs tags.
2. TypeScript decodes embedding BLOBs and computes cosine similarity.
3. Maintain an in-memory top-K for `limit`.
4. Return the same `SearchChunkPointer[]`.

Avoid `statement.all(...)` for large candidate sets. Add an iterator/streaming method for search candidates or let the search service use `better-sqlite3` iteration directly.

## Target Architecture

### Runtime

`createAgentRuntime` should:

1. Resolve paths:
   - `resolveAgentSqlitePath(dataDir)`;
   - `resolveLegacyPgliteDataDir(dataDir)`.
2. Create `<dataDir>/db`.
3. Reject unsupported legacy PGlite state when SQLite is absent.
4. Open `better-sqlite3`.
5. Apply PRAGMAs:
   - `PRAGMA journal_mode = WAL`;
   - `PRAGMA synchronous = NORMAL`;
   - `PRAGMA foreign_keys = ON`;
   - `PRAGMA busy_timeout = 5000`.
6. Create the Drizzle SQLite database.
7. Apply SQLite migrations through `drizzle-orm/better-sqlite3/migrator`.
8. Create repositories and services.
9. Close the SQLite database on shutdown.

### Raw Database Adapter

Introduce a small raw SQL interface:

```ts
export interface AgentDb {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}
```

SQLite implementation:

- wraps a `better-sqlite3` database;
- uses `statement.all(...)` for result queries;
- uses `statement.run(...)` for mutating statements;
- keeps an async facade for existing call sites;
- supports either explicit `?` placeholders or a deliberately limited `$1` to `?` rewrite for static project SQL only.

Prefer manually converting raw SQL to `?` if the rewrite becomes hard to reason about.

### Drizzle Database

Move `packages/agent/src/repositories/database.ts` to:

- `drizzle-orm/better-sqlite3`;
- `BetterSQLite3Database`;
- SQLite transaction types;
- schema from `sqlite-core` models.

Important: `better-sqlite3` Drizzle transactions are synchronous. Existing `transaction(async (tx) => ...)` call sites must be rewritten so the transaction callback does not return a Promise.

### Repository Models

Replace `pg-core` with `sqlite-core`.

Mapping:

| PostgreSQL model type | SQLite model type |
| --- | --- |
| `pgTable` | `sqliteTable` |
| `bigint(..., { mode: 'number' })` | `integer(..., { mode: 'number' })` |
| `integer(...)` | `integer(...)` |
| `boolean(...)` | `integer(..., { mode: 'boolean' })` |
| `text(...)` | `text(...)` |
| `vector(...)` | `blob('embedding', { mode: 'buffer' })` or custom SQLite type |
| `primaryKey(...)` | `primaryKey(...)` from `sqlite-core` |
| `index(...)` / `uniqueIndex(...)` | `index(...)` / `uniqueIndex(...)` from `sqlite-core` |

Also update `table-repository.ts` from `AnyPgTable` / `AnyPgColumn` to SQLite equivalents.

## Work Plan

### Phase 1. Inventory

1. Confirm PGlite references are limited to `packages/agent`, `package-lock.json`, README, generated migrations, and this plan.
2. Record all raw SQL call sites, including `commands/status-query.ts`.
3. Confirm deployment PostgreSQL references are out of scope.

Audit command:

```sh
rg -n "PGlite|pglite|pg-core|drizzle-orm/pglite|vector|<=>|CAST\\(|USING btree|\\$[0-9]+|TRUE|FALSE" packages/agent -S
```

### Phase 2. Dependencies

1. Decide Node policy:
   - pin a Node 18-compatible `better-sqlite3`, or
   - raise package engine to Node 20+.
2. After explicit permission, run npm install for SQLite dependencies.
3. Remove PGlite dependency.

### Phase 3. SQLite Runtime

1. Add SQLite path helpers and legacy PGlite detection.
2. Add `packages/agent/src/runtime/sqlite-agent-db.ts`.
3. Apply PRAGMAs.
4. Add fail-fast legacy behavior when SQLite is missing and `PG_VERSION` is present.
5. Update `AgentDb` type.

### Phase 4. Drizzle Schema

1. Convert repository models from `pg-core` to `sqlite-core`.
2. Replace the embedding custom type with BLOB storage helpers.
3. Convert boolean columns to SQLite boolean mode.
4. Convert id columns to SQLite integer number mode.
5. Convert `table-repository.ts` generic constraints.
6. Convert `repositories/database.ts` to `drizzle-orm/better-sqlite3`.
7. Rewrite async Drizzle transactions to synchronous callbacks.

### Phase 5. SQLite Migrations

1. Update `packages/agent/drizzle.config.ts`:
   - `dialect: 'sqlite'`;
   - SQLite-compatible `dbCredentials`;
   - unchanged schema path.
2. Generate a new SQLite baseline.
3. Remove PostgreSQL-only SQL:
   - `vector`;
   - `USING btree`;
   - `CASCADE`;
   - PostgreSQL `boolean`;
   - PostgreSQL `bigint`.
4. Update `packages/agent/drizzle/meta/_journal.json` to SQLite dialect.
5. Run:

```sh
npm -w @grepmind/agent run build:migrations
```

### Phase 6. Raw SQL

General changes:

- replace `CAST($7 AS vector)` with a BLOB parameter;
- replace vector literal encoding with `encodeEmbedding`;
- replace SQL `TRUE` / `FALSE` with `1` / `0` or parameters;
- convert or explicitly support `$N` placeholders;
- keep `ON CONFLICT ... DO UPDATE`, which SQLite supports;
- verify `LIKE ... ESCAPE '~'` path filtering.

Files to update:

- `ArtifactImportService`;
- `project-sync/local-state.ts`;
- `project-sync/revision-delta.ts`;
- `project-sync/invalidations.ts`;
- `project-sync/sync-state.ts`;
- `AgentRpcIdempotencyStore`;
- `commands/status-query.ts`;
- local search service.

### Phase 7. Search

1. Rename `LocalPgliteSearchService` to `LocalSqliteSearchService`.
2. Keep request validation unchanged.
3. Preserve current behavior: `code` searches with tags return empty results.
4. Select candidates without vector distance:
   - `binding_id`;
   - `revision_id`;
   - optional path filter through `project_revision_files`;
   - docs tag filters through `EXISTS`.
5. Iterate candidates, decode BLOB embeddings, compute cosine similarity, and maintain top-K.
6. Sort final results by score descending.
7. Add trace logging for candidate count and optionally warn on large scans.

### Phase 8. Cleanup Semantics

Ensure local cleanup removes the same data as before:

- chunks;
- docs chunk tags;
- files;
- attachments;
- sync state;
- materializations;
- project registration rows.

Current cleanup should explicitly cover `docs_chunk_tags`; do not rely on foreign keys unless the SQLite schema adds and verifies them.

### Phase 9. Runtime Wiring and Docs

In `packages/agent/src/runtime/agent-runtime.ts`:

- remove PGlite imports;
- remove vector extension imports;
- remove `CREATE EXTENSION`;
- replace PGlite migrator with SQLite migrator;
- create the SQLite raw adapter;
- create the Drizzle SQLite database;
- replace search service wiring;
- keep bootstrap, repositories, projects, sync lifecycle, and close behavior.

Docs and metadata:

- update `packages/agent/package.json` description and dependencies;
- update `packages/agent/README.md`:
  - SQLite storage note;
  - explicit no-migration/reset behavior for old PGlite data;
  - register/sync instructions after reset;
  - troubleshooting for legacy data detection;
- remove the PGlite vector path workaround from `tsconfig.types.json`.

## Verification

Do not use `test` or `tsc`.

Minimum build verification:

```sh
npm run build:agent
```

Package verification:

```sh
npm -w @grepmind/agent pack --dry-run
```

Manual smoke scenarios:

1. Fresh data directory:
   - start runtime with a new `--data-dir`;
   - verify `<dataDir>/db/agent.sqlite` is created;
   - verify migrations apply.
2. Legacy PGlite data directory:
   - prepare a directory with `PG_VERSION`;
   - verify startup fails with the documented message;
   - verify no PGlite files are deleted.
3. Register and sync after reset:
   - register a workspace;
   - sync project state;
   - verify branches, revisions, files, profiles, and materializations.
4. Search:
   - code vector search;
   - docs vector search with tags;
   - path-filtered search.
5. Status:
   - run `status|state` with filters.
6. Cleanup:
   - run `clean --workspace`;
   - run `clean --all`;
   - verify chunks, docs tags, materializations, and project rows are removed.

## Completion Criteria

- `packages/agent/src` has no runtime imports from `@electric-sql/pglite`.
- Active schema has no imports from `drizzle-orm/pg-core`.
- Active migrations use SQLite dialect.
- Embedded migrations are generated from SQLite migrations.
- Fresh startup creates SQLite and applies migrations.
- Existing PGlite data directories are rejected with explicit documented behavior.
- Search returns results without pgvector.
- Status and cleanup work on SQLite.
- Agent package build passes.
- README documents SQLite storage and no-migration reset behavior.

## Main Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Old local data is not migrated | Users must re-register and sync | Fail fast on legacy PGlite markers and document reset behavior |
| Node engine mismatch | Install/runtime failure | Pin compatible `better-sqlite3` or raise engine to Node 20+ |
| Async transaction callbacks | Partial writes outside transaction | Rewrite transaction callbacks to synchronous SQLite-compatible code |
| Vector search performance regression | Large revisions require scanning embeddings | Candidate filters, iterator-based scanning, top-K, trace metrics |
| Placeholder mismatch | Raw SQL fails | Manual `?` conversion or constrained adapter rewrite |
| Boolean mismatch | Filters behave incorrectly | SQLite boolean mode plus explicit `0`/`1` in raw SQL |
| Cleanup leftovers | Stale docs tags or materializations | Add explicit cleanup coverage and smoke checks |

## Recommended PR Order

1. Dependencies, SQLite schema, and migration baseline.
2. SQLite adapter, runtime wiring, and legacy fail-fast detection.
3. Raw SQL conversion and transaction cleanup.
4. Search service replacement.
5. Cleanup/status/docs/package verification.
