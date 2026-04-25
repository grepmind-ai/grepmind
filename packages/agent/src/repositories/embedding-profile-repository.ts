import { and, asc, eq, notInArray } from 'drizzle-orm';
import type { EmbeddingProfileDescriptor } from '../backend/contracts/index.js';
import type { AgentDatabase, AgentDatabaseExecutor } from './database.js';
import { embeddingProfiles } from './models/embedding-profiles.js';
import { AgentBindingTableRepository } from './table-repository.js';

export type EmbeddingProfileRow = typeof embeddingProfiles.$inferSelect;
export type EmbeddingProfileInsert = typeof embeddingProfiles.$inferInsert;

export class EmbeddingProfileRepository extends AgentBindingTableRepository<
  typeof embeddingProfiles
> {
  constructor(db: AgentDatabase) {
    super(db, embeddingProfiles);
  }

  async listByBindingId(bindingId: number): Promise<EmbeddingProfileRow[]> {
    return this.select()
      .where(eq(embeddingProfiles.bindingId, bindingId))
      .orderBy(asc(embeddingProfiles.target));
  }

  async replaceForBinding(
    bindingId: number,
    profiles: EmbeddingProfileDescriptor[],
    executor?: AgentDatabaseExecutor,
  ): Promise<void> {
    const db = this.getExecutor(executor);
    const targets = profiles.map((profile) => profile.target);

    if (targets.length === 0) {
      await this.deleteByBindingId(bindingId, executor);
      return;
    }

    await db
      .delete(embeddingProfiles)
      .where(
        and(
          eq(embeddingProfiles.bindingId, bindingId),
          notInArray(embeddingProfiles.target, targets),
        ),
      );

    for (const profile of profiles) {
      await this.insert(
        {
          bindingId,
          target: profile.target,
          profileVersion: profile.profileVersion,
          model: profile.model,
          dimensions: profile.dimensions,
          embeddingSpace: profile.embeddingSpace,
          artifactSchemaVersion: profile.artifactSchemaVersion,
          distanceMetric: profile.distanceMetric,
          updatedAt: profile.updatedAt,
        } satisfies EmbeddingProfileInsert,
        executor,
      ).onConflictDoUpdate({
        target: [embeddingProfiles.bindingId, embeddingProfiles.target],
        set: {
          profileVersion: profile.profileVersion,
          model: profile.model,
          dimensions: profile.dimensions,
          embeddingSpace: profile.embeddingSpace,
          artifactSchemaVersion: profile.artifactSchemaVersion,
          distanceMetric: profile.distanceMetric,
          updatedAt: profile.updatedAt,
        },
      });
    }
  }
}
