import { bigint, index, pgTable, text } from 'drizzle-orm/pg-core';

export const projectBindingSyncState = pgTable(
  'project_binding_sync_state',
  {
    bindingId: bigint('binding_id', { mode: 'number' }).primaryKey(),
    status: text('status').notNull(),
    errorMessage: text('error_message'),
    lastSyncStartedAt: text('last_sync_started_at'),
    lastSyncCompletedAt: text('last_sync_completed_at'),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('project_binding_sync_state_status_idx').on(table.status, table.updatedAt),
  ],
);
