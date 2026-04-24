import type {
  BranchCursorState,
  LocalMaterializationState,
  LocalProfileState,
  PendingRevisionState,
  SearchTarget,
} from '../../backend/contracts/index.js';
import type { AgentDb } from '../../db/schema.js';
import type { LocalSyncSnapshot, SyncCompleteness } from './types.js';

interface AttachmentSyncStateRow {
  attachment_id: number | string;
  revision_id: number | string;
  files_synced: boolean | number | string;
}

interface BranchCursorRow {
  branch: string;
  max_known_attachment_id: number | string;
}

interface MaterializationRow {
  revision_id: number | string;
  target: SearchTarget;
  profile_version: number | string;
  artifact_schema_version: number | string;
  materialized_at: string;
}

interface PayloadRevisionRow {
  revision_id: number | string;
  needs_files_sync: boolean | number | string;
}

interface ProfileRow {
  target: SearchTarget;
  profile_version: number | string;
  dimensions: number | string;
  artifact_schema_version: number | string;
}

export async function loadLocalSyncSnapshot(
  db: AgentDb,
  bindingId: number,
  targets: SearchTarget[],
): Promise<LocalSyncSnapshot> {
  const [
    branchCursorResult,
    attachmentStateResult,
    materializationResult,
    profilesResult,
    payloadRevisionResult,
  ] = await Promise.all([
    db.query<BranchCursorRow>(
      `
      WITH sync_branches AS (
        SELECT branch
        FROM project_branches
        WHERE binding_id = $1
          AND (viewer_tracked = TRUE OR is_default = TRUE)
      )
      SELECT
        pra.branch,
        MAX(pra.attachment_id) AS max_known_attachment_id
      FROM project_revision_attachments pra
      INNER JOIN sync_branches sb
        ON sb.branch = pra.branch
      WHERE pra.binding_id = $1
      GROUP BY pra.branch
      ORDER BY pra.branch ASC
      `,
      [bindingId],
    ),
    db.query<AttachmentSyncStateRow>(
      `
      SELECT attachment_id, revision_id, files_synced
      FROM project_attachment_sync_state
      WHERE binding_id = $1
        AND files_synced = FALSE
      ORDER BY attachment_id ASC
      `,
      [bindingId],
    ),
    db.query<MaterializationRow>(
      `
      SELECT
        revision_id,
        target,
        profile_version,
        artifact_schema_version,
        materialized_at
      FROM project_materializations
      WHERE binding_id = $1
        AND status = 'ready'
      ORDER BY materialized_at DESC, revision_id DESC
      `,
      [bindingId],
    ),
    db.query<ProfileRow>(
      `
      SELECT target, profile_version, dimensions, artifact_schema_version
      FROM embedding_profiles
      WHERE binding_id = $1
      ORDER BY target ASC
      `,
      [bindingId],
    ),
    db.query<PayloadRevisionRow>(
      `
      SELECT revision_id, needs_files_sync
      FROM project_revisions
      WHERE binding_id = $1
      ORDER BY revision_id ASC
      `,
      [bindingId],
    ),
  ]);

  const attachmentStateByAttachmentId = new Map<number, SyncCompleteness>();
  for (const row of attachmentStateResult.rows) {
    attachmentStateByAttachmentId.set(Number(row.attachment_id), {
      filesSynced: toDbBoolean(row.files_synced),
    });
  }

  const payloadStateByRevisionId = new Map<number, SyncCompleteness>();
  for (const row of payloadRevisionResult.rows) {
    payloadStateByRevisionId.set(Number(row.revision_id), {
      filesSynced: !toDbBoolean(row.needs_files_sync),
    });
  }

  return {
    requestLocalState: {
      branchCursors: branchCursorResult.rows.map<BranchCursorState>((row) => ({
        branch: row.branch,
        maxKnownAttachmentId: Number(row.max_known_attachment_id),
      })),
      pendingRevisions: attachmentStateResult.rows.map<PendingRevisionState>((row) => ({
        attachmentId: Number(row.attachment_id),
        revisionId: Number(row.revision_id),
        filesSynced: toDbBoolean(row.files_synced),
      })),
      materializations: materializationResult.rows
        .filter((row) => targets.includes(row.target))
        .map<LocalMaterializationState>((row) => ({
          revisionId: Number(row.revision_id),
          target: row.target,
          profileVersion: Number(row.profile_version),
          artifactSchemaVersion: Number(row.artifact_schema_version),
          materializedAt: row.materialized_at,
        })),
      profiles: profilesResult.rows
        .filter((row) => targets.includes(row.target))
        .map<LocalProfileState>((row) => ({
          target: row.target,
          profileVersion: Number(row.profile_version),
          dimensions: Number(row.dimensions),
          artifactSchemaVersion: Number(row.artifact_schema_version),
        })),
      targets,
    },
    payloadStateByRevisionId,
    attachmentStateByAttachmentId,
  };
}

function toDbBoolean(value: boolean | number | string): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }

  return value === '1' || value.toLowerCase() === 'true' || value.toLowerCase() === 't';
}
