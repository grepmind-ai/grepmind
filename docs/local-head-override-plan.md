# Local HEAD Override Plan for Dirty Workspaces

## Goal

Make changed files from the current workspace reliably indexable and searchable before the user creates a commit.

Requirements:

- Do not modify the user's working tree.
- Do not change the current branch.
- Do not add files to the real git index.
- Do not require temporary user-visible commits.
- Do not upload a full repository snapshot when only a small set of files changed.
- Reuse as much of the existing `searchHead -> syncHead -> materialization -> search` flow as possible.
- Deduplicate identical dirty overlays so the same set of changes is not indexed repeatedly.

## Current Architecture

Local search is currently tied to the real `HEAD`:

1. `LocalHeadService.readObservedHead(...)` reads `branch` via `git rev-parse --abbrev-ref HEAD`.
2. It reads `headCommitSha` via `git rev-parse HEAD`.
3. `RevisionPublicationService.ensureAttachedAndSyncHead(...)` publishes exactly that commit.
4. `SearchHeadService.searchByLocalHead(...)` resolves a revision for the `branch + headCommitSha` pair.
5. If the revision has not been imported locally yet, `searchHead` runs the repair path through `syncHead` and `syncProject`.
6. Exact `rg` can already read the working tree, but that is only an additional signal on top of semantic results, not full indexing for dirty files.

The limitation: uncommitted changes do not have a backend revision, so the current materialization path cannot index them.

## Selected Approach

Use a local head overlay revision based on the current real `HEAD`.

The agent sends only a delta:

- `baseHeadCommitSha`;
- changed file contents;
- new untracked file contents;
- deleted file tombstones;
- file mode changes when relevant;
- an `overrideFingerprint` for dedupe and idempotency.

The backend materializes the dirty revision as:

```text
effective revision = base revision + overlay delta
```

This is the primary design because uploading a full `git archive` for a one-file edit is not acceptable.

## Non-Goal

The synthetic commit plus `git archive <sha>` approach is not the primary implementation because it uploads the whole repository tree. It can remain only as a local debugging fallback or a last-resort compatibility path behind a separate feature flag.

## Target Model

For a clean workspace, behavior stays unchanged:

```ts
{
  branch,
  headCommitSha: realHeadSha,
  dirty: false
}
```

For a dirty workspace, the agent returns an effective local head:

```ts
{
  branch,
  headCommitSha: realHeadSha,
  baseHeadCommitSha: realHeadSha,
  overrideFingerprint,
  dirty: true,
  localRevisionKey: `local:${realHeadSha}:${overrideFingerprint}`
}
```

`headCommitSha` remains the real commit sha. The dirty identity is the pair:

```text
baseHeadCommitSha + overrideFingerprint
```

This avoids pretending that the dirty workspace is a remote branch commit.

## Overlay Construction

Add a `LocalHeadOverrideService`.

Algorithm:

1. Resolve branch and real head:

```bash
git rev-parse --abbrev-ref HEAD
git rev-parse HEAD
```

2. Read changed paths using porcelain output:

```bash
git status --porcelain=v1 -z --untracked-files=all
```

3. Classify paths into:

- added;
- modified;
- deleted;
- renamed;
- typechanged;
- untracked.

4. For changed and untracked regular files, read current working tree bytes from disk.

5. For deleted files, emit tombstones.

6. For renamed files, emit tombstone for the old path and content for the new path. This keeps backend materialization simple.

7. Build per-file hashes:

```text
sha256(relativePath + "\0" + fileMode + "\0" + contentBytes)
sha256(relativePath + "\0deleted")
```

8. Build overlay fingerprint:

```text
sha256(baseHeadCommitSha + "\n" + normalizedRemoteFingerprint + "\n" + sortedFileEntries)
```

9. Enforce limits before upload:

- max changed file count;
- max single file bytes;
- max total overlay bytes;
- ignored/binary policy for semantic indexing.

## Overlay Transport

Add a backend contract for local head overlays.

Request:

```ts
interface LocalHeadOverlaySyncRequest {
  deviceId: string;
  attachEpoch: number;
  branch: string;
  baseHeadCommitSha: string;
  overrideFingerprint: string;
  observedAt?: string;
  remoteFingerprint?: string;
  files: LocalHeadOverlayFile[];
}

type LocalHeadOverlayFile =
  | {
      kind: 'upsert';
      path: string;
      mode?: string;
      sizeBytes: number;
      sha256: string;
      contentBase64: string;
    }
  | {
      kind: 'delete';
      path: string;
    };
```

Response:

```ts
interface LocalHeadOverlaySyncResponse {
  decision: 'materialized' | 'queued' | 'stale_rejected';
  baseHeadCommitSha: string;
  overrideFingerprint: string;
  revisionId: number | null;
  attachmentId: number | null;
  jobId?: string;
}
```

Endpoint shape:

```text
POST /api/agent/v1/projects/:bindingId/head-overlays
```

The existing `syncHead` endpoint remains responsible for clean real `HEAD` commits.

## Backend Materialization Model

The backend should store overlay revisions as explicit local-source revisions:

```ts
sourceKind: 'local_head_overlay';
baseHeadCommitSha: string;
overrideFingerprint: string;
```

Materialization steps:

1. Resolve the base revision for `baseHeadCommitSha`.
2. Copy or reference unchanged file metadata from the base revision.
3. Apply delete tombstones.
4. Apply upsert files from the overlay payload.
5. Chunk and embed only upserted files.
6. Reuse base chunks for unchanged files.
7. Produce a normal searchable revisionId.

This keeps transfer and embedding cost proportional to the dirty diff, not repository size.

## Local Search Flow

`SearchHeadService.searchByLocalHead(...)`:

1. Reads effective local head.
2. If clean, uses the existing `branch + headCommitSha` path.
3. If dirty, computes or reuses the overlay fingerprint.
4. Looks up a local revision attachment by `branch + baseHeadCommitSha + overrideFingerprint`.
5. If missing, calls overlay repair:

```text
syncLocalHeadOverlay -> syncProject(target) -> poll revision attachment
```

6. Searches the materialized overlay revision.

## Publication Flow

`RevisionPublicationService.ensureAttachedAndSyncHead(...)`:

- keeps the current `syncHead(...)` path for clean workspaces;
- uses `syncLocalHeadOverlay(...)` for dirty workspaces when the feature flag is enabled;
- records queued/materialized state using `baseHeadCommitSha + overrideFingerprint`;
- logs dirty overlay metadata.

## Local State and Lookup

Add local attachment lookup for overlay revisions:

```ts
findRevisionForLocalHeadOverlay(
  bindingId: number,
  branch: string,
  baseHeadCommitSha: string,
  overrideFingerprint: string,
): Promise<number | null>
```

If the existing project revision attachment table cannot represent this cleanly, add a separate local table:

```sql
local_head_overlay_revisions(
  binding_id,
  branch,
  base_head_commit_sha,
  override_fingerprint,
  revision_id,
  attachment_id,
  created_at,
  updated_at
)
```

## Race Conditions

Protect against workspace changes while the overlay is being built.

Before and after reading file contents, re-read:

- current branch;
- real `HEAD`;
- `git status --porcelain=v1 -z --untracked-files=all`;

If branch or real `HEAD` changed, return `LOCAL_HEAD_CHANGED` and let the caller retry.

If status or per-file content hashes changed, rebuild the overlay a bounded number of times, for example 2 attempts. After that, return a retryable error.

This prevents mixed snapshots where metadata and file bytes come from different workspace moments.

## Feature Flag

First version is guarded by:

```text
GREPMIND_LOCAL_HEAD_OVERLAY=1
```

Without the feature flag, behavior remains unchanged.

Avoid naming the flag `LOCAL_HEAD_OVERRIDE` if the implementation is overlay/delta based. The flag should describe the actual transport.

## Limits and Fallbacks

Recommended initial limits:

- `MAX_OVERLAY_FILES`: 500;
- `MAX_OVERLAY_FILE_BYTES`: 1 MiB for semantic indexing by default;
- `MAX_OVERLAY_TOTAL_BYTES`: 10 MiB;
- skip or mark binary files unless docs/code indexing explicitly supports them.

If limits are exceeded:

- return a clear retryable or actionable error;
- do not silently fall back to full repository upload;
- allow a future explicit opt-in full snapshot fallback only with a separate flag.

## Observability

Add trace/info logs for:

- clean vs dirty effective head decision;
- changed file count;
- total overlay bytes;
- overlay fingerprint;
- overlay sync decision;
- materialized overlay revisionId;
- retry caused by changed workspace content.

Add diagnostic fields to `agent_status`:

```ts
localHead: {
  (branch,
    headCommitSha,
    dirty,
    baseHeadCommitSha,
    overrideFingerprint,
    overlayFileCount,
    overlayTotalBytes);
}
```

## Edge Cases

- Detached HEAD: keep the current rejection behavior for v1.
- Submodules: represent gitlink changes as metadata changes first; dirty submodule contents are out of scope for v1.
- Ignored files: do not include them because porcelain status with normal git rules excludes ignored files.
- LFS files: send the pointer file content, matching normal git semantics.
- File mode changes: include mode metadata.
- Deleted files: send delete tombstones.
- Untracked files: send file content as upserts.
- Renames: encode as delete old path plus upsert new path.
- Binary files: skip by default for semantic indexing unless target-specific support exists.

## Implementation Steps

1. Add `LocalHeadOverrideService` that computes dirty status, file deltas, per-file hashes, total bytes, and `overrideFingerprint`.
2. Add `LocalHeadOverlaySyncRequest` and `LocalHeadOverlaySyncResponse` contracts.
3. Add `AgentBackendClient.syncLocalHeadOverlay(...)`.
4. Add backend endpoint `POST /api/agent/v1/projects/:bindingId/head-overlays`.
5. Add backend materialization for `local_head_overlay` revisions as `base revision + overlay delta`.
6. Add local revision attachment lookup by `baseHeadCommitSha + overrideFingerprint`.
7. Move `SearchHeadService` to effective overlay head under `GREPMIND_LOCAL_HEAD_OVERLAY`.
8. Move `RevisionPublicationService` to overlay sync under the same feature flag.
9. Add race detection and bounded retry.
10. Add `agent_status` diagnostics.
11. Add cleanup for stale local overlay metadata and backend overlay records if needed.
12. After stabilization, enable the feature flag by default.

## Acceptance Criteria

- Editing one file uploads only that file's content and overlay metadata, not a full repository archive.
- A dirty file containing a new symbol is found by semantic search before commit.
- A modified file is searched using the new content, not the old `HEAD` content.
- A deleted file does not appear in dirty overlay revision results.
- An untracked file is indexed and searchable.
- Repeating a search without further changes reuses the same overlay revision.
- Editing a file during overlay build causes a retry or retryable error, not a mixed snapshot.
- Clean workspace continues to use the real `HEAD` path.
- The user's real git index does not change.
- The current branch and `HEAD` do not change.
