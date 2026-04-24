import type { AgentBackendClient } from '../../backend/agent-backend-client.js';
import type {
  ListRevisionFilesPageResponse,
  RevisionDelta,
  RevisionFileDto,
} from '../../backend/contracts/index.js';
import type { AgentDb } from '../../db/schema.js';
import type {
  LocalSyncSnapshot,
  RevisionProcessingState,
  SyncCompleteness,
} from './types.js';

export interface ProcessRevisionDeltaInput {
  db: AgentDb;
  backend: AgentBackendClient;
  bindingId: number;
  revision: RevisionDelta;
  localState: LocalSyncSnapshot;
  completedAttachmentIds: Set<number>;
}

export async function processRevisionDelta(input: ProcessRevisionDeltaInput): Promise<void> {
  const {
    db,
    backend,
    bindingId,
    revision,
    localState,
    completedAttachmentIds,
  } = input;

  await upsertAttachmentInventory(db, bindingId, revision);

  const progress = resolveRevisionProcessingState(
    localState.payloadStateByRevisionId.get(revision.revisionId),
    revision,
  );

  await upsertRevision(db, bindingId, revision, progress);

  if (isComplete(progress)) {
    markRevisionComplete(localState, completedAttachmentIds, revision);
  } else {
    await persistAttachmentState(db, bindingId, revision.attachmentId, revision.revisionId, progress);
    markRevisionPending(localState, revision, progress);
  }

  if (progress.needsFilesSync) {
    await syncRevisionFiles(db, backend, bindingId, revision);
    progress.filesSynced = true;
    progress.needsFilesSync = false;
    await persistAttachmentState(db, bindingId, revision.attachmentId, revision.revisionId, progress);
  }

  if (isComplete(progress)) {
    markRevisionComplete(localState, completedAttachmentIds, revision);
    return;
  }

  markRevisionPending(localState, revision, progress);
}

function resolveRevisionProcessingState(
  payloadState: SyncCompleteness | undefined,
  revision: RevisionDelta,
): RevisionProcessingState {
  const filesSynced = payloadState?.filesSynced ?? !revision.needsFilesSync;

  return {
    filesSynced,
    needsFilesSync: revision.needsFilesSync && !filesSynced,
  };
}

async function syncRevisionFiles(
  db: AgentDb,
  backend: AgentBackendClient,
  bindingId: number,
  revision: RevisionDelta,
): Promise<void> {
  let cursor: string | undefined;
  const limit = revision.filesPage?.limit;
  let firstPage = true;

  do {
    const page = await backend.listRevisionFilesPage(
      bindingId,
      revision.revisionId,
      cursor,
      limit,
    );
    if (firstPage) {
      await db.query(
        `
        DELETE FROM project_revision_files
        WHERE binding_id = $1
          AND revision_id = $2
        `,
        [bindingId, revision.revisionId],
      );
      firstPage = false;
    }
    await applyRevisionFilesPage(db, bindingId, page);
    cursor = page.nextCursor;
  } while (cursor);

  await db.query(
    `
    UPDATE project_revisions
    SET needs_files_sync = FALSE,
        files_cursor = NULL,
        files_synced_at = $3
    WHERE binding_id = $1
      AND revision_id = $2
    `,
    [bindingId, revision.revisionId, new Date().toISOString()],
  );
}

async function applyRevisionFilesPage(
  db: AgentDb,
  bindingId: number,
  page: ListRevisionFilesPageResponse,
): Promise<void> {
  for (const file of page.items) {
    await upsertRevisionFile(db, bindingId, page.revisionId, file);
  }
}

async function upsertAttachmentInventory(
  db: AgentDb,
  bindingId: number,
  revision: RevisionDelta,
): Promise<void> {
  const now = new Date().toISOString();
  await db.query(
    `
    INSERT INTO project_revision_attachments (
      binding_id,
      attachment_id,
      revision_id,
      repo_branch_id,
      branch,
      visibility,
      owner_binding_id,
      source_kind,
      attached_at,
      updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (binding_id, attachment_id) DO UPDATE
    SET revision_id = excluded.revision_id,
        repo_branch_id = excluded.repo_branch_id,
        branch = excluded.branch,
        visibility = excluded.visibility,
        owner_binding_id = excluded.owner_binding_id,
        source_kind = excluded.source_kind,
        attached_at = excluded.attached_at,
        updated_at = excluded.updated_at
    `,
    [
      bindingId,
      revision.attachmentId,
      revision.revisionId,
      revision.repoBranchId,
      revision.branch,
      revision.visibility,
      revision.ownerBindingId,
      revision.sourceKind,
      revision.ingestedAt,
      now,
    ],
  );
}

async function upsertRevision(
  db: AgentDb,
  bindingId: number,
  revision: RevisionDelta,
  progress: RevisionProcessingState,
): Promise<void> {
  await db.query(
    `
    INSERT INTO project_revisions (
      binding_id,
      revision_id,
      ref,
      commit_sha,
      ingested_at,
      file_count,
      total_bytes,
      needs_files_sync,
      files_cursor,
      files_synced_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL)
    ON CONFLICT (binding_id, revision_id) DO UPDATE
    SET ref = excluded.ref,
        commit_sha = excluded.commit_sha,
        ingested_at = excluded.ingested_at,
        file_count = excluded.file_count,
        total_bytes = excluded.total_bytes,
        needs_files_sync = excluded.needs_files_sync,
        files_cursor = excluded.files_cursor
    `,
    [
      bindingId,
      revision.revisionId,
      revision.ref ?? null,
      revision.commitSha,
      revision.ingestedAt,
      revision.fileCount,
      revision.totalBytes,
      progress.needsFilesSync,
      null,
    ],
  );
}

async function upsertRevisionFile(
  db: AgentDb,
  bindingId: number,
  revisionId: number,
  file: RevisionFileDto,
): Promise<void> {
  await db.query(
    `
    INSERT INTO project_revision_files (
      binding_id,
      revision_id,
      file_id,
      artifact_ref,
      updated_at
    )
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (binding_id, revision_id, file_id) DO UPDATE
    SET artifact_ref = excluded.artifact_ref,
        updated_at = excluded.updated_at
    `,
    [
      bindingId,
      revisionId,
      file.fileId,
      file.artifactRef ?? null,
      new Date().toISOString(),
    ],
  );
}

async function persistAttachmentState(
  db: AgentDb,
  bindingId: number,
  attachmentId: number,
  revisionId: number,
  state: SyncCompleteness,
): Promise<void> {
  if (state.filesSynced) {
    return;
  }

  const now = new Date().toISOString();
  await db.query(
    `
    INSERT INTO project_attachment_sync_state (
      binding_id,
      attachment_id,
      revision_id,
      files_synced,
      synced_at,
      updated_at
    )
    VALUES ($1, $2, $3, $4, NULL, $5)
    ON CONFLICT (binding_id, attachment_id) DO UPDATE
    SET revision_id = excluded.revision_id,
        files_synced = excluded.files_synced,
        updated_at = excluded.updated_at
    `,
    [
      bindingId,
      attachmentId,
      revisionId,
      state.filesSynced,
      now,
    ],
  );
}

function isComplete(state: SyncCompleteness): boolean {
  return state.filesSynced;
}

function markRevisionComplete(
  localState: LocalSyncSnapshot,
  completedAttachmentIds: Set<number>,
  revision: RevisionDelta,
): void {
  completedAttachmentIds.add(revision.attachmentId);
  localState.attachmentStateByAttachmentId.delete(revision.attachmentId);
  localState.payloadStateByRevisionId.set(revision.revisionId, {
    filesSynced: true,
  });
}

function markRevisionPending(
  localState: LocalSyncSnapshot,
  revision: RevisionDelta,
  state: SyncCompleteness,
): void {
  localState.attachmentStateByAttachmentId.set(revision.attachmentId, {
    filesSynced: state.filesSynced,
  });
  localState.payloadStateByRevisionId.set(revision.revisionId, {
    filesSynced: state.filesSynced,
  });
}
