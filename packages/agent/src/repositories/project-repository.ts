import { desc, eq } from 'drizzle-orm';
import type { AgentDatabase, AgentDatabaseExecutor } from './database.js';
import { projects } from './models/projects.js';
import { AgentBindingTableRepository } from './table-repository.js';

export type ProjectRow = typeof projects.$inferSelect;
export type ProjectInsert = typeof projects.$inferInsert;

export interface UpsertProjectRecordInput {
  bindingId: number;
  repoId: number;
  userRepoId: number | null;
  repoFullName: string;
  displayName: string;
  workspacePath: string;
  workspaceFingerprint: string | null;
  defaultBranch: string;
  activeBranch: string;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export class ProjectRepository extends AgentBindingTableRepository<typeof projects> {
  constructor(db: AgentDatabase) {
    super(db, projects);
  }

  async listAll(): Promise<ProjectRow[]> {
    return this.select().orderBy(desc(projects.updatedAt), desc(projects.bindingId));
  }

  async findByBindingId(bindingId: number): Promise<ProjectRow | null> {
    const [row] = await this.select()
      .where(eq(projects.bindingId, bindingId))
      .limit(1);

    return row ?? null;
  }

  async upsertProjection(
    input: UpsertProjectRecordInput,
    executor?: AgentDatabaseExecutor,
  ): Promise<ProjectRow> {
    const values = {
      bindingId: input.bindingId,
      repoId: input.repoId,
      userRepoId: input.userRepoId,
      repoFullName: input.repoFullName,
      displayName: input.displayName,
      workspacePath: input.workspacePath,
      workspaceFingerprint: input.workspaceFingerprint,
      defaultBranch: input.defaultBranch,
      activeBranch: input.activeBranch,
      lastSyncedAt: input.lastSyncedAt,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    } satisfies ProjectInsert;

    const [row] = await this.insert(values, executor)
      .onConflictDoUpdate({
        target: projects.bindingId,
        set: {
          repoId: values.repoId,
          userRepoId: values.userRepoId,
          repoFullName: values.repoFullName,
          displayName: values.displayName,
          workspacePath: values.workspacePath,
          workspaceFingerprint: values.workspaceFingerprint,
          defaultBranch: values.defaultBranch,
          activeBranch: values.activeBranch,
          lastSyncedAt: values.lastSyncedAt,
          updatedAt: values.updatedAt,
        },
      })
      .returning();

    if (!row) {
      throw new Error(`Failed to upsert local project ${input.bindingId}`);
    }

    return row;
  }
}
