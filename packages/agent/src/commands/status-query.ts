import type { SearchTarget } from '../backend/contracts/index.js';
import type { AgentDb } from '../db/schema.js';

interface StatusAttachmentRow {
  binding_id: number | string;
  attachment_id: number | string;
  revision_id: number | string;
  branch: string;
  visibility: 'canonical' | 'binding_private';
  owner_binding_id: number | string | null;
  source_kind: 'remote_branch' | 'agent_snapshot';
  commit_sha: string;
  files_synced: boolean | number | string;
}

interface StatusPayloadRow {
  binding_id: number | string;
  revision_id: number | string;
  commit_sha: string;
  ingested_at: string;
  file_count: number | string;
  total_bytes: number | string;
  needs_files_sync: boolean | number | string;
}

interface StatusMaterializationRow {
  binding_id: number | string;
  revision_id: number | string;
  branch: string;
  target: SearchTarget;
  profile_version: number | string;
  artifact_schema_version: number | string;
  status: string;
  materialized_at: string;
}

export interface AgentStatusQuery {
  bindingId?: number;
  branch?: string;
  commitSha?: string;
  limit?: number;
}

export interface AgentStatusSnapshot {
  filters: {
    bindingId: number | null;
    branch: string | null;
    commitSha: string | null;
    limit: number;
  };
  attachments: Array<{
    bindingId: number;
    attachmentId: number;
    revisionId: number;
    branch: string;
    visibility: 'canonical' | 'binding_private';
    ownerBindingId: number | null;
    sourceKind: 'remote_branch' | 'agent_snapshot';
    commitSha: string;
    filesSynced: boolean;
  }>;
  payloads: Array<{
    bindingId: number;
    revisionId: number;
    commitSha: string;
    ingestedAt: string;
    fileCount: number;
    totalBytes: number;
    needsFilesSync: boolean;
  }>;
  materializations: Array<{
    bindingId: number;
    revisionId: number;
    branch: string;
    target: SearchTarget;
    profileVersion: number;
    artifactSchemaVersion: number;
    status: string;
    materializedAt: string;
  }>;
}

export async function loadAgentStatusSnapshot(
  db: AgentDb,
  input: AgentStatusQuery = {},
): Promise<AgentStatusSnapshot> {
  const limit = input.limit ?? 100;
  if (!Number.isFinite(limit) || limit < 1) {
    throw new Error('--limit must be a positive number');
  }

  const attachmentWhereClauses: string[] = [];
  const attachmentParams: Array<number | string> = [];

  if (input.bindingId != null) {
    attachmentParams.push(input.bindingId);
    attachmentWhereClauses.push(`a.binding_id = $${attachmentParams.length}`);
  }
  if (input.branch) {
    attachmentParams.push(input.branch);
    attachmentWhereClauses.push(`a.branch = $${attachmentParams.length}`);
  }
  if (input.commitSha) {
    attachmentParams.push(input.commitSha);
    attachmentWhereClauses.push(`pr.commit_sha = $${attachmentParams.length}`);
  }

  attachmentParams.push(limit);
  const attachmentLimitParam = `$${attachmentParams.length}`;
  const attachmentWhereSql = attachmentWhereClauses.length > 0
    ? `WHERE ${attachmentWhereClauses.join(' AND ')}`
    : '';

  const attachmentsResult = await db.query<StatusAttachmentRow>(
    `
    SELECT
      a.binding_id,
      a.attachment_id,
      a.revision_id,
      a.branch,
      a.visibility,
      a.owner_binding_id,
      a.source_kind,
      pr.commit_sha,
      COALESCE(s.files_synced, TRUE) AS files_synced
    FROM project_revision_attachments a
    INNER JOIN project_revisions pr
      ON pr.binding_id = a.binding_id
     AND pr.revision_id = a.revision_id
    LEFT JOIN project_attachment_sync_state s
      ON s.binding_id = a.binding_id
     AND s.attachment_id = a.attachment_id
    ${attachmentWhereSql}
    ORDER BY a.attachment_id DESC, a.revision_id DESC
    LIMIT ${attachmentLimitParam}
    `,
    attachmentParams,
  );

  const payloadWhereClauses: string[] = [];
  const payloadParams: Array<number | string> = [];

  if (input.bindingId != null) {
    payloadParams.push(input.bindingId);
    payloadWhereClauses.push(`pr.binding_id = $${payloadParams.length}`);
  }
  if (input.commitSha) {
    payloadParams.push(input.commitSha);
    payloadWhereClauses.push(`pr.commit_sha = $${payloadParams.length}`);
  }
  if (input.branch) {
    payloadParams.push(input.branch);
    payloadWhereClauses.push(
      `EXISTS (
        SELECT 1
        FROM project_revision_attachments a
        WHERE a.binding_id = pr.binding_id
          AND a.revision_id = pr.revision_id
          AND a.branch = $${payloadParams.length}
      )`,
    );
  }

  payloadParams.push(limit);
  const payloadLimitParam = `$${payloadParams.length}`;
  const payloadWhereSql = payloadWhereClauses.length > 0
    ? `WHERE ${payloadWhereClauses.join(' AND ')}`
    : '';

  const payloadsResult = await db.query<StatusPayloadRow>(
    `
    SELECT
      pr.binding_id,
      pr.revision_id,
      pr.commit_sha,
      pr.ingested_at,
      pr.file_count,
      pr.total_bytes,
      pr.needs_files_sync
    FROM project_revisions pr
    ${payloadWhereSql}
    ORDER BY pr.ingested_at DESC, pr.revision_id DESC
    LIMIT ${payloadLimitParam}
    `,
    payloadParams,
  );

  const materializationWhereClauses: string[] = [];
  const materializationParams: Array<number | string> = [];

  if (input.bindingId != null) {
    materializationParams.push(input.bindingId);
    materializationWhereClauses.push(`pm.binding_id = $${materializationParams.length}`);
  }
  if (input.branch) {
    materializationParams.push(input.branch);
    materializationWhereClauses.push(`pm.branch = $${materializationParams.length}`);
  }
  if (input.commitSha) {
    materializationParams.push(input.commitSha);
    materializationWhereClauses.push(`pr.commit_sha = $${materializationParams.length}`);
  }

  materializationParams.push(limit);
  const materializationLimitParam = `$${materializationParams.length}`;
  const materializationWhereSql = materializationWhereClauses.length > 0
    ? `WHERE ${materializationWhereClauses.join(' AND ')}`
    : '';

  const materializationsResult = await db.query<StatusMaterializationRow>(
    `
    SELECT
      pm.binding_id,
      pm.revision_id,
      pm.branch,
      pm.target,
      pm.profile_version,
      pm.artifact_schema_version,
      pm.status,
      pm.materialized_at
    FROM project_materializations pm
    INNER JOIN project_revisions pr
      ON pr.binding_id = pm.binding_id
     AND pr.revision_id = pm.revision_id
    ${materializationWhereSql}
    ORDER BY pm.materialized_at DESC, pm.revision_id DESC
    LIMIT ${materializationLimitParam}
    `,
    materializationParams,
  );

  return {
    filters: {
      bindingId: input.bindingId ?? null,
      branch: input.branch ?? null,
      commitSha: input.commitSha ?? null,
      limit,
    },
    attachments: attachmentsResult.rows.map((row) => ({
      bindingId: Number(row.binding_id),
      attachmentId: Number(row.attachment_id),
      revisionId: Number(row.revision_id),
      branch: row.branch,
      visibility: row.visibility,
      ownerBindingId: row.owner_binding_id == null ? null : Number(row.owner_binding_id),
      sourceKind: row.source_kind,
      commitSha: row.commit_sha,
      filesSynced: toDbBoolean(row.files_synced),
    })),
    payloads: payloadsResult.rows.map((row) => ({
      bindingId: Number(row.binding_id),
      revisionId: Number(row.revision_id),
      commitSha: row.commit_sha,
      ingestedAt: row.ingested_at,
      fileCount: Number(row.file_count),
      totalBytes: Number(row.total_bytes),
      needsFilesSync: toDbBoolean(row.needs_files_sync),
    })),
    materializations: materializationsResult.rows.map((row) => ({
      bindingId: Number(row.binding_id),
      revisionId: Number(row.revision_id),
      branch: row.branch,
      target: row.target,
      profileVersion: Number(row.profile_version),
      artifactSchemaVersion: Number(row.artifact_schema_version),
      status: row.status,
      materializedAt: row.materialized_at,
    })),
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
