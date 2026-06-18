import { bigint, index, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';

export const projectRevisionFiles = pgTable(
  'project_revision_files',
  {
    bindingId: bigint('binding_id', { mode: 'number' }).notNull(),
    revisionId: bigint('revision_id', { mode: 'number' }).notNull(),
    fileId: bigint('file_id', { mode: 'number' }).notNull(),
    path: text('path').notNull().default(''),
    artifactRef: text('artifact_ref'),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.bindingId, table.revisionId, table.fileId] }),
    index('project_revision_files_binding_revision_idx').on(
      table.bindingId,
      table.revisionId,
    ),
    index('project_revision_files_binding_revision_artifact_idx').on(
      table.bindingId,
      table.revisionId,
      table.artifactRef,
    ),
    index('project_revision_files_binding_revision_path_idx').on(
      table.bindingId,
      table.revisionId,
      table.path,
    ),
  ],
);
