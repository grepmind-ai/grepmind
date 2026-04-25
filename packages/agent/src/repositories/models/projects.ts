import { bigint, index, pgTable, text } from 'drizzle-orm/pg-core';

export const projects = pgTable(
  'projects',
  {
    bindingId: bigint('binding_id', { mode: 'number' }).primaryKey(),
    repoId: bigint('repo_id', { mode: 'number' }).notNull(),
    userRepoId: bigint('user_repo_id', { mode: 'number' }),
    repoFullName: text('repo_full_name').notNull(),
    displayName: text('display_name').notNull(),
    workspacePath: text('workspace_path').notNull(),
    workspaceFingerprint: text('workspace_fingerprint'),
    defaultBranch: text('default_branch').notNull(),
    activeBranch: text('active_branch').notNull(),
    lastSyncedAt: text('last_synced_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [index('projects_repo_idx').on(table.repoId)],
);
