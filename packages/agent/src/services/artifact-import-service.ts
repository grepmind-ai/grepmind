import {
  AgentBackendClientError,
  type AgentBackendClient,
} from '../backend/agent-backend-client.js';
import type {
  ArtifactBatchRef,
  ArtifactImportItem,
  EmbeddingProfileDescriptor,
  GetArtifactsBatchResponse,
  MaterializationPlan,
  SearchTarget,
} from '../backend/contracts/index.js';
import type { AgentDb } from '../db/schema.js';

interface RevisionFileRefRow {
  file_id: number | string;
  artifact_ref: string;
}

interface ProfileRow {
  profile_version: number | string;
  model: string;
  dimensions: number | string;
  embedding_space: string;
  artifact_schema_version: number | string;
  distance_metric: EmbeddingProfileDescriptor['distanceMetric'];
  updated_at: string;
}

export class ArtifactImportService {
  constructor(
    private readonly db: AgentDb,
    private readonly backend: AgentBackendClient,
    private readonly maxArtifactRefsPerBatch: number,
  ) {}

  async materializePlans(
    bindingId: number,
    plans: MaterializationPlan[],
  ): Promise<void> {
    for (const plan of plans) {
      await this.materializePlan(bindingId, plan);
    }
  }

  async clearMaterialization(
    bindingId: number,
    revisionId: number,
    target: SearchTarget,
  ): Promise<void> {
    const tableName = getChunkTableName(target);
    if (target === 'docs') {
      await this.db.query(
        `
        DELETE FROM docs_chunk_tags
        WHERE binding_id = $1
          AND revision_id = $2
        `,
        [bindingId, revisionId],
      );
    }
    await this.db.query(
      `DELETE FROM ${tableName} WHERE binding_id = $1 AND revision_id = $2`,
      [bindingId, revisionId],
    );
    await this.db.query(
      `
      DELETE FROM project_materializations
      WHERE binding_id = $1
        AND revision_id = $2
        AND target = $3
      `,
      [bindingId, revisionId, target],
    );
  }

  async clearTarget(bindingId: number, target: SearchTarget): Promise<void> {
    const tableName = getChunkTableName(target);
    if (target === 'docs') {
      await this.db.query(
        `
        DELETE FROM docs_chunk_tags
        WHERE binding_id = $1
        `,
        [bindingId],
      );
    }
    await this.db.query(
      `DELETE FROM ${tableName} WHERE binding_id = $1`,
      [bindingId],
    );
    await this.db.query(
      `
      DELETE FROM project_materializations
      WHERE binding_id = $1
        AND target = $2
      `,
      [bindingId, target],
    );
  }

  private async materializePlan(
    bindingId: number,
    plan: MaterializationPlan,
  ): Promise<void> {
    if (plan.replaceRevisionId != null) {
      await this.clearMaterialization(bindingId, plan.replaceRevisionId, plan.target);
    }

    const branch = plan.branch;
    const profile = await this.requireProfile(bindingId, plan.target);
    if (profile.profileVersion !== plan.desiredProfileVersion) {
      throw new Error(
        `Local embedding profile mismatch for ${plan.target}: expected ${plan.desiredProfileVersion}, got ${profile.profileVersion}`,
      );
    }

    const refs = await this.listArtifactRefs(bindingId, plan.revisionId, plan.target);
    if (refs.length === 0) {
      await this.upsertMaterialization(bindingId, plan.revisionId, branch, plan.target, profile);
      return;
    }

    for (const batch of chunkArray(refs, this.maxArtifactRefsPerBatch)) {
      const response = await this.getArtifactsBatchWithAdaptiveSplitting(
        bindingId,
        plan.target,
        batch,
      );

      if (response.notFound.length > 0 || response.stale.length > 0) {
        throw new Error(
          `Artifact import failed for binding ${bindingId}, revision ${plan.revisionId}, target ${plan.target}`,
        );
      }

      for (const item of response.items) {
        this.validateImportItem(item, profile);
        await this.importItem(bindingId, item);
      }
    }

    await this.upsertMaterialization(bindingId, plan.revisionId, branch, plan.target, profile);
  }

  private async importItem(
    bindingId: number,
    item: ArtifactImportItem,
  ): Promise<void> {
    if (item.target === 'code') {
      for (const chunk of item.chunks) {
        await this.db.query(
          `
          INSERT INTO code_chunks (
            row_id,
            binding_id,
            revision_id,
            file_id,
            chunk_id,
            profile_version,
            embedding,
            updated_at
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, CAST($7 AS vector), $8
          )
          ON CONFLICT (row_id) DO UPDATE
          SET revision_id = excluded.revision_id,
              file_id = excluded.file_id,
              chunk_id = excluded.chunk_id,
              profile_version = excluded.profile_version,
              embedding = excluded.embedding,
              updated_at = excluded.updated_at
          `,
          [
            buildChunkRowId(bindingId, item.target, item.revisionId, item.fileId, chunk.chunkId),
            bindingId,
            item.revisionId,
            item.fileId,
            chunk.chunkId,
            item.profileVersion,
            toVectorLiteral(chunk.embedding),
            new Date().toISOString(),
          ],
        );
      }
      return;
    }

    for (const chunk of item.chunks) {
      const rowId = buildChunkRowId(bindingId, item.target, item.revisionId, item.fileId, chunk.chunkId);
      await this.db.query(
        `
        INSERT INTO docs_chunks (
          row_id,
          binding_id,
          revision_id,
          file_id,
          chunk_id,
          profile_version,
          embedding,
          updated_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, CAST($7 AS vector), $8
        )
        ON CONFLICT (row_id) DO UPDATE
        SET revision_id = excluded.revision_id,
            file_id = excluded.file_id,
            chunk_id = excluded.chunk_id,
            profile_version = excluded.profile_version,
            embedding = excluded.embedding,
            updated_at = excluded.updated_at
        `,
        [
          rowId,
          bindingId,
          item.revisionId,
          item.fileId,
          chunk.chunkId,
          item.profileVersion,
          toVectorLiteral(chunk.embedding),
          new Date().toISOString(),
        ],
      );
      await this.replaceDocsChunkTags({
        rowId,
        bindingId,
        revisionId: item.revisionId,
        fileId: item.fileId,
        chunkId: chunk.chunkId,
        tags: normalizeTags(chunk.tags ?? []),
      });
    }
  }

  private validateImportItem(
    item: ArtifactImportItem,
    profile: EmbeddingProfileDescriptor,
  ): void {
    if (item.profileVersion !== profile.profileVersion) {
      throw new Error(
        `Artifact profile mismatch for ${item.target}: expected ${profile.profileVersion}, got ${item.profileVersion}`,
      );
    }
    if (item.artifactSchemaVersion !== profile.artifactSchemaVersion) {
      throw new Error(
        `Artifact schema mismatch for ${item.target}: expected ${profile.artifactSchemaVersion}, got ${item.artifactSchemaVersion}`,
      );
    }

    for (const chunk of item.chunks) {
      if (chunk.embedding.length !== profile.dimensions) {
        throw new Error(
          `Artifact embedding dimension mismatch for ${item.target}: expected ${profile.dimensions}, got ${chunk.embedding.length}`,
        );
      }
    }
  }

  private async requireProfile(
    bindingId: number,
    target: SearchTarget,
  ): Promise<EmbeddingProfileDescriptor> {
    const result = await this.db.query<ProfileRow>(
      `
      SELECT
        profile_version,
        model,
        dimensions,
        embedding_space,
        artifact_schema_version,
        distance_metric,
        updated_at
      FROM embedding_profiles
      WHERE binding_id = $1
        AND target = $2
      LIMIT 1
      `,
      [bindingId, target],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error(`Embedding profile for ${target} is missing locally`);
    }

    return {
      target,
      profileVersion: Number(row.profile_version),
      model: row.model,
      dimensions: Number(row.dimensions),
      embeddingSpace: row.embedding_space,
      artifactSchemaVersion: Number(row.artifact_schema_version),
      distanceMetric: row.distance_metric,
      updatedAt: row.updated_at,
    };
  }

  private async listArtifactRefs(
    bindingId: number,
    revisionId: number,
    target: SearchTarget,
  ): Promise<ArtifactBatchRef[]> {
    const result = await this.db.query<RevisionFileRefRow>(
      `
      SELECT file_id, artifact_ref
      FROM project_revision_files
      WHERE binding_id = $1
        AND revision_id = $2
        AND artifact_ref LIKE $3
      ORDER BY file_id ASC
      `,
      [bindingId, revisionId, `%:${target}`],
    );

    return result.rows.map((row) => ({
      kind: 'artifact_ref' as const,
      artifactRef: row.artifact_ref,
      revisionId,
    }));
  }

  private async getArtifactsBatchWithAdaptiveSplitting(
    bindingId: number,
    target: SearchTarget,
    refs: ArtifactBatchRef[],
  ): Promise<GetArtifactsBatchResponse> {
    try {
      return await this.backend.getArtifactsBatch(bindingId, {
        target,
        refs,
        includeBody: false,
      });
    } catch (error) {
      if (!isArtifactBatchLimitExceeded(error)) {
        throw error;
      }

      if (refs.length === 1) {
        throw new Error(
          `Artifact batch import failed: single artifact exceeds backend batch size limit (${describeArtifactRef(refs[0])})`,
        );
      }

      const midpoint = Math.ceil(refs.length / 2);
      const first = await this.getArtifactsBatchWithAdaptiveSplitting(
        bindingId,
        target,
        refs.slice(0, midpoint),
      );
      const second = await this.getArtifactsBatchWithAdaptiveSplitting(
        bindingId,
        target,
        refs.slice(midpoint),
      );

      return {
        items: [...first.items, ...second.items],
        notFound: [...first.notFound, ...second.notFound],
        stale: [...first.stale, ...second.stale],
      };
    }
  }

  private async upsertMaterialization(
    bindingId: number,
    revisionId: number,
    branch: string,
    target: SearchTarget,
    profile: EmbeddingProfileDescriptor,
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.db.query(
      `
      INSERT INTO project_materializations (
        binding_id,
        revision_id,
        branch,
        target,
        profile_version,
        artifact_schema_version,
        status,
        materialized_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'ready', $7, $7)
      ON CONFLICT (binding_id, revision_id, target) DO UPDATE
      SET branch = excluded.branch,
          profile_version = excluded.profile_version,
          artifact_schema_version = excluded.artifact_schema_version,
          status = excluded.status,
          materialized_at = excluded.materialized_at,
          updated_at = excluded.updated_at
      `,
      [
        bindingId,
        revisionId,
        branch,
        target,
        profile.profileVersion,
        profile.artifactSchemaVersion,
        now,
      ],
    );
  }

  private async replaceDocsChunkTags(input: {
    rowId: string;
    bindingId: number;
    revisionId: number;
    fileId: number;
    chunkId: string;
    tags: string[];
  }): Promise<void> {
    await this.db.query(
      `
      DELETE FROM docs_chunk_tags
      WHERE row_id = $1
      `,
      [input.rowId],
    );

    if (input.tags.length === 0) {
      return;
    }

    const updatedAt = new Date().toISOString();
    for (const tag of input.tags) {
      await this.db.query(
        `
        INSERT INTO docs_chunk_tags (
          row_id,
          binding_id,
          revision_id,
          file_id,
          chunk_id,
          tag,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (row_id, tag) DO UPDATE
        SET updated_at = excluded.updated_at
        `,
        [
          input.rowId,
          input.bindingId,
          input.revisionId,
          input.fileId,
          input.chunkId,
          tag,
          updatedAt,
        ],
      );
    }
  }
}

function buildChunkRowId(
  bindingId: number,
  target: SearchTarget,
  revisionId: number,
  fileId: number,
  chunkId: string,
): string {
  return `${bindingId}:${target}:${revisionId}:${fileId}:${chunkId}`;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  if (size <= 0) {
    return [items];
  }

  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function isArtifactBatchLimitExceeded(error: unknown): error is AgentBackendClientError {
  return error instanceof AgentBackendClientError && error.code === 'LIMIT_EXCEEDED';
}

function describeArtifactRef(ref: ArtifactBatchRef): string {
  if (ref.kind === 'artifact_ref') {
    return ref.artifactRef;
  }

  return `${ref.revisionId}:${ref.fileId}`;
}

function getChunkTableName(target: SearchTarget): 'code_chunks' | 'docs_chunks' {
  return target === 'code' ? 'code_chunks' : 'docs_chunks';
}

function normalizeTags(value: string[]): string[] {
  return [...new Set(
    value
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  )];
}

function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`;
}
