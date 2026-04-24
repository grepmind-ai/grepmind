import { and, asc, desc, eq, notInArray, or } from 'drizzle-orm';
import type { BranchDescriptor } from '../backend/contracts/index.js';
import type { AgentDatabase, AgentDatabaseExecutor } from './database.js';
import { projectBranches } from './models/project-branches.js';
import { AgentBindingTableRepository } from './table-repository.js';

export type ProjectBranchRow = typeof projectBranches.$inferSelect;
export type ProjectBranchInsert = typeof projectBranches.$inferInsert;

export class ProjectBranchRepository extends AgentBindingTableRepository<typeof projectBranches> {
  constructor(db: AgentDatabase) {
    super(db, projectBranches);
  }

  async listByBindingId(bindingId: number): Promise<ProjectBranchRow[]> {
    return this.select()
      .where(eq(projectBranches.bindingId, bindingId))
      .orderBy(desc(projectBranches.isDefault), asc(projectBranches.branch));
  }

  async listSearchableBranchNames(bindingId: number): Promise<string[]> {
    const rows = await this.getExecutor()
      .select({ branch: projectBranches.branch })
      .from(projectBranches)
      .where(
        and(
          eq(projectBranches.bindingId, bindingId),
          or(
            eq(projectBranches.viewerTracked, true),
            eq(projectBranches.isDefault, true),
          ),
        ),
      )
      .orderBy(desc(projectBranches.isDefault), asc(projectBranches.branch));

    return rows.map((row) => row.branch);
  }

  async replaceForBinding(
    bindingId: number,
    updatedAt: string,
    branches: BranchDescriptor[],
    executor?: AgentDatabaseExecutor,
  ): Promise<void> {
    const db = this.getExecutor(executor);
    const branchNames = branches.map((branch) => branch.branch);

    if (branchNames.length === 0) {
      await this.deleteByBindingId(bindingId, executor);
      return;
    }

    await db
      .delete(projectBranches)
      .where(
        and(
          eq(projectBranches.bindingId, bindingId),
          notInArray(projectBranches.branch, branchNames),
        ),
      );

    for (const branch of branches) {
      await this.insert({
        bindingId,
        repoBranchId: branch.repoBranchId ?? null,
        branch: branch.branch,
        canonicalTrackingMode: branch.canonicalTrackingMode,
        isDefault: branch.isDefault,
        viewerTracked: branch.viewerTracked,
        isActiveForUser: branch.isActiveForUser,
        syncStatus: branch.sync.status,
        syncLastSeenRemoteCommitSha: branch.sync.lastSeenRemoteCommitSha ?? null,
        syncLastSyncedCommitSha: branch.sync.lastSyncedCommitSha ?? null,
        syncLastSyncStartedAt: branch.sync.lastSyncStartedAt ?? null,
        syncLastSyncCompletedAt: branch.sync.lastSyncCompletedAt ?? null,
        syncErrorMessage: branch.sync.errorMessage ?? null,
        updatedAt,
      } satisfies ProjectBranchInsert, executor)
        .onConflictDoUpdate({
          target: [projectBranches.bindingId, projectBranches.branch],
          set: {
            repoBranchId: branch.repoBranchId ?? null,
            canonicalTrackingMode: branch.canonicalTrackingMode,
            isDefault: branch.isDefault,
            viewerTracked: branch.viewerTracked,
            isActiveForUser: branch.isActiveForUser,
            syncStatus: branch.sync.status,
            syncLastSeenRemoteCommitSha: branch.sync.lastSeenRemoteCommitSha ?? null,
            syncLastSyncedCommitSha: branch.sync.lastSyncedCommitSha ?? null,
            syncLastSyncStartedAt: branch.sync.lastSyncStartedAt ?? null,
            syncLastSyncCompletedAt: branch.sync.lastSyncCompletedAt ?? null,
            syncErrorMessage: branch.sync.errorMessage ?? null,
            updatedAt,
          },
        });
    }
  }
}
