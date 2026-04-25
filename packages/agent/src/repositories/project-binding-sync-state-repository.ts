import { eq } from 'drizzle-orm';
import type { AgentDatabase, AgentDatabaseExecutor } from './database.js';
import { projectBindingSyncState } from './models/project-binding-sync-state.js';
import { AgentBindingTableRepository } from './table-repository.js';

export type ProjectBindingSyncStateRow =
  typeof projectBindingSyncState.$inferSelect;
export type ProjectBindingSyncStateInsert =
  typeof projectBindingSyncState.$inferInsert;

export class ProjectBindingSyncStateRepository extends AgentBindingTableRepository<
  typeof projectBindingSyncState
> {
  constructor(db: AgentDatabase) {
    super(db, projectBindingSyncState);
  }

  async findByBindingId(
    bindingId: number,
  ): Promise<ProjectBindingSyncStateRow | null> {
    const [row] = await this.select()
      .where(eq(projectBindingSyncState.bindingId, bindingId))
      .limit(1);

    return row ?? null;
  }

  async ensureIdle(
    bindingId: number,
    updatedAt: string,
    executor?: AgentDatabaseExecutor,
  ): Promise<void> {
    await this.insert(
      {
        bindingId,
        status: 'idle',
        errorMessage: null,
        lastSyncStartedAt: null,
        lastSyncCompletedAt: null,
        updatedAt,
      } satisfies ProjectBindingSyncStateInsert,
      executor,
    ).onConflictDoNothing({
      target: projectBindingSyncState.bindingId,
    });
  }
}
