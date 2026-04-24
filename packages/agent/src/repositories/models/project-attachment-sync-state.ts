import { bigint, boolean, index, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';

export const projectAttachmentSyncState = pgTable(
  'project_attachment_sync_state',
  {
    bindingId: bigint('binding_id', { mode: 'number' }).notNull(),
    attachmentId: bigint('attachment_id', { mode: 'number' }).notNull(),
    revisionId: bigint('revision_id', { mode: 'number' }).notNull(),
    filesSynced: boolean('files_synced').notNull(),
    syncedAt: text('synced_at'),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.bindingId, table.attachmentId] }),
    index('project_attachment_sync_state_binding_updated_idx').on(table.bindingId, table.updatedAt),
    index('project_attachment_sync_state_binding_revision_idx').on(
      table.bindingId,
      table.revisionId,
      table.attachmentId,
    ),
  ],
);
