import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
} from 'drizzle-orm/pg-core';

export const projectRevisions = pgTable(
  'project_revisions',
  {
    bindingId: bigint('binding_id', { mode: 'number' }).notNull(),
    revisionId: bigint('revision_id', { mode: 'number' }).notNull(),
    ref: text('ref'),
    commitSha: text('commit_sha').notNull(),
    ingestedAt: text('ingested_at').notNull(),
    fileCount: integer('file_count').notNull(),
    totalBytes: integer('total_bytes').notNull(),
    needsFilesSync: boolean('needs_files_sync').notNull(),
    filesCursor: text('files_cursor'),
    filesSyncedAt: text('files_synced_at'),
  },
  (table) => [
    primaryKey({ columns: [table.bindingId, table.revisionId] }),
    index('project_revisions_binding_ingested_revision_idx').on(
      table.bindingId,
      table.ingestedAt,
      table.revisionId,
    ),
    index('project_revisions_binding_commit_idx').on(
      table.bindingId,
      table.commitSha,
    ),
  ],
);
