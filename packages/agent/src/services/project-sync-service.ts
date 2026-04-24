import type { AgentBackendClient } from '../backend/agent-backend-client.js';
import type {
  InvalidationHint,
  MaterializationPlan,
  RevisionTombstone,
  SearchTarget,
} from '../backend/contracts/index.js';
import type { AgentDb } from '../db/schema.js';
import { ArtifactImportService } from './artifact-import-service.js';
import {
  applyInvalidations,
  applyStaleRevisions,
  clearCompletedAttachmentState,
} from './project-sync/invalidations.js';
import { loadLocalSyncSnapshot } from './project-sync/local-state.js';
import {
  buildInvalidationKey,
  buildMaterializationPlanKey,
  shouldCountRevisionWork,
  uniqueTargets,
} from './project-sync/revision-state.js';
import { processRevisionDelta } from './project-sync/revision-delta.js';
import {
  markSyncCompleted,
  markSyncErrored,
  markSyncStarted,
} from './project-sync/sync-state.js';
import type { SyncProjectOptions, SyncProjectResult } from './project-sync/types.js';
import { ProjectRegistryService } from './project-registry-service.js';

export type { SyncProjectOptions, SyncProjectResult } from './project-sync/types.js';

export class ProjectSyncService {
  private readonly artifactImportService: ArtifactImportService;

  constructor(
    private readonly db: AgentDb,
    private readonly backend: AgentBackendClient,
    private readonly projectRegistry: ProjectRegistryService,
    maxArtifactRefsPerBatch: number,
  ) {
    this.artifactImportService = new ArtifactImportService(
      db,
      backend,
      maxArtifactRefsPerBatch,
    );
  }

  async syncProject(
    bindingId: number,
    options: SyncProjectOptions = {},
  ): Promise<SyncProjectResult> {
    const targets = uniqueTargets(options.targets ?? ['code', 'docs']);
    const localState = await loadLocalSyncSnapshot(this.db, bindingId, targets);
    const completedAttachmentIds = new Set<number>();
    const invalidations = new Map<string, InvalidationHint>();
    const materializationPlans = new Map<string, MaterializationPlan>();
    const staleAttachments = new Map<number, RevisionTombstone>();
    const startedAt = new Date().toISOString();
    let revisionCount = 0;

    await markSyncStarted(this.db, bindingId, startedAt);

    try {
      let cursor: string | undefined;

      do {
        const page = await this.backend.syncProject(bindingId, {
          localState: localState.requestLocalState,
          cursor,
        });

        await this.projectRegistry.upsertProjectProjection({
          project: page.project,
          branches: page.branches,
          embeddingProfiles: page.embeddingProfiles,
        });

        for (const invalidation of page.invalidations) {
          invalidations.set(buildInvalidationKey(invalidation), invalidation);
        }
        for (const plan of page.materializationPlan) {
          materializationPlans.set(buildMaterializationPlanKey(plan), plan);
        }
        for (const staleAttachment of page.staleRevisions) {
          staleAttachments.set(staleAttachment.attachmentId, staleAttachment);
        }

        for (const revision of page.revisions) {
          if (shouldCountRevisionWork(localState, revision)) {
            revisionCount += 1;
          }
          await processRevisionDelta({
            db: this.db,
            backend: this.backend,
            bindingId,
            revision,
            localState,
            completedAttachmentIds,
          });
        }

        cursor = page.nextCursor;
      } while (cursor);

      await applyInvalidations(
        this.artifactImportService,
        bindingId,
        [...invalidations.values()],
      );
      await applyStaleRevisions(this.db, bindingId, [...staleAttachments.values()]);
      await clearCompletedAttachmentState(this.db, bindingId, completedAttachmentIds);
      await this.artifactImportService.materializePlans(
        bindingId,
        [...materializationPlans.values()],
      );

      const completedAt = new Date().toISOString();
      await markSyncCompleted(this.db, bindingId, completedAt);

      return {
        bindingId,
        revisionCount,
        materializedPlanCount: materializationPlans.size,
        invalidationCount: invalidations.size,
        syncedAt: completedAt,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown sync error';
      await markSyncErrored(this.db, bindingId, message);
      throw error;
    }
  }

  async syncAllProjects(options: SyncProjectOptions = {}): Promise<SyncProjectResult[]> {
    const projects = await this.projectRegistry.listProjects();
    const results: SyncProjectResult[] = [];
    for (const project of projects) {
      results.push(await this.syncProject(project.bindingId, options));
    }
    return results;
  }
}
