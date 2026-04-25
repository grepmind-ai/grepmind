import type {
  InvalidationHint,
  RevisionTombstone,
} from '../../backend/contracts/index.js';
import type { AgentDb } from '../../db/schema.js';
import { ArtifactImportService } from '../artifact-import-service.js';

export async function applyInvalidations(
  artifactImportService: ArtifactImportService,
  bindingId: number,
  invalidations: InvalidationHint[],
): Promise<void> {
  for (const invalidation of invalidations) {
    if (invalidation.kind === 'RECREATE_INDEX') {
      await artifactImportService.clearTarget(bindingId, invalidation.target);
      continue;
    }

    if (invalidation.revisionId != null) {
      await artifactImportService.clearMaterialization(
        bindingId,
        invalidation.revisionId,
        invalidation.target,
      );
    }
  }
}

export async function applyStaleRevisions(
  db: AgentDb,
  bindingId: number,
  staleRevisions: RevisionTombstone[],
): Promise<void> {
  for (const staleRevision of staleRevisions) {
    await db.query(
      `
      DELETE FROM project_attachment_sync_state
      WHERE binding_id = $1
        AND attachment_id = $2
      `,
      [bindingId, staleRevision.attachmentId],
    );
    await db.query(
      `
      DELETE FROM project_revision_attachments
      WHERE binding_id = $1
        AND attachment_id = $2
      `,
      [bindingId, staleRevision.attachmentId],
    );
    await deletePayloadIfUnused(db, bindingId, staleRevision.revisionId);
  }
}

export async function clearCompletedAttachmentState(
  db: AgentDb,
  bindingId: number,
  attachmentIds: Set<number>,
): Promise<void> {
  if (attachmentIds.size === 0) {
    return;
  }

  const ids = [...attachmentIds];
  const placeholders = ids.map((_, index) => `$${index + 2}`).join(', ');
  await db.query(
    `
    DELETE FROM project_attachment_sync_state
    WHERE binding_id = $1
      AND attachment_id IN (${placeholders})
    `,
    [bindingId, ...ids],
  );
}

async function deletePayloadIfUnused(
  db: AgentDb,
  bindingId: number,
  revisionId: number,
): Promise<void> {
  const attachmentCountResult = await db.query<{ count: number | string }>(
    `
    SELECT COUNT(*) AS count
    FROM project_revision_attachments
    WHERE binding_id = $1
      AND revision_id = $2
    `,
    [bindingId, revisionId],
  );
  if (Number(attachmentCountResult.rows[0]?.count ?? 0) > 0) {
    return;
  }

  const materializationCountResult = await db.query<{ count: number | string }>(
    `
    SELECT COUNT(*) AS count
    FROM project_materializations
    WHERE binding_id = $1
      AND revision_id = $2
    `,
    [bindingId, revisionId],
  );
  if (Number(materializationCountResult.rows[0]?.count ?? 0) > 0) {
    return;
  }

  await db.query(
    `
    DELETE FROM project_revision_files
    WHERE binding_id = $1
      AND revision_id = $2
    `,
    [bindingId, revisionId],
  );
  await db.query(
    `
    DELETE FROM code_chunks
    WHERE binding_id = $1
      AND revision_id = $2
    `,
    [bindingId, revisionId],
  );
  await db.query(
    `
    DELETE FROM docs_chunks
    WHERE binding_id = $1
      AND revision_id = $2
    `,
    [bindingId, revisionId],
  );
  await db.query(
    `
    DELETE FROM project_revisions
    WHERE binding_id = $1
      AND revision_id = $2
    `,
    [bindingId, revisionId],
  );
}
