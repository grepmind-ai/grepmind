import { bigint, index, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';

export const docsChunkTags = pgTable(
  'docs_chunk_tags',
  {
    rowId: text('row_id').notNull(),
    bindingId: bigint('binding_id', { mode: 'number' }).notNull(),
    revisionId: bigint('revision_id', { mode: 'number' }).notNull(),
    fileId: bigint('file_id', { mode: 'number' }).notNull(),
    chunkId: text('chunk_id').notNull(),
    tag: text('tag').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.rowId, table.tag] }),
    index('docs_chunk_tags_binding_revision_tag_idx').on(
      table.bindingId,
      table.revisionId,
      table.tag,
    ),
    index('docs_chunk_tags_binding_revision_chunk_idx').on(
      table.bindingId,
      table.revisionId,
      table.fileId,
      table.chunkId,
    ),
  ],
);
