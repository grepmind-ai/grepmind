import { bigint, boolean, index, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core';

export const projectBranches = pgTable(
  'project_branches',
  {
    bindingId: bigint('binding_id', { mode: 'number' }).notNull(),
    repoBranchId: bigint('repo_branch_id', { mode: 'number' }),
    branch: text('branch').notNull(),
    canonicalTrackingMode: text('canonical_tracking_mode').notNull(),
    isDefault: boolean('is_default').notNull(),
    viewerTracked: boolean('viewer_tracked').notNull(),
    isActiveForUser: boolean('is_active_for_user').notNull(),
    syncStatus: text('sync_status').notNull(),
    syncLastSeenRemoteCommitSha: text('sync_last_seen_remote_commit_sha'),
    syncLastSyncedCommitSha: text('sync_last_synced_commit_sha'),
    syncLastSyncStartedAt: text('sync_last_sync_started_at'),
    syncLastSyncCompletedAt: text('sync_last_sync_completed_at'),
    syncErrorMessage: text('sync_error_message'),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.bindingId, table.branch] }),
    uniqueIndex('project_branches_binding_repo_branch_uq').on(table.bindingId, table.repoBranchId),
    index('project_branches_binding_active_idx').on(
      table.bindingId,
      table.isActiveForUser,
      table.isDefault,
      table.branch,
    ),
  ],
);
