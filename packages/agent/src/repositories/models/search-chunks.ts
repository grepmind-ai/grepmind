import { bigint, index, integer, pgTable, text } from 'drizzle-orm/pg-core';
import { vector } from './custom-types.js';

export const codeChunks = pgTable(
  'code_chunks',
  {
    rowId: text('row_id').primaryKey(),
    bindingId: bigint('binding_id', { mode: 'number' }).notNull(),
    revisionId: bigint('revision_id', { mode: 'number' }).notNull(),
    fileId: bigint('file_id', { mode: 'number' }).notNull(),
    chunkId: text('chunk_id').notNull(),
    profileVersion: integer('profile_version').notNull(),
    embedding: vector('embedding').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('code_chunks_binding_revision_idx').on(
      table.bindingId,
      table.revisionId,
    ),
    index('code_chunks_binding_profile_idx').on(
      table.bindingId,
      table.profileVersion,
    ),
  ],
);

export const docsChunks = pgTable(
  'docs_chunks',
  {
    rowId: text('row_id').primaryKey(),
    bindingId: bigint('binding_id', { mode: 'number' }).notNull(),
    revisionId: bigint('revision_id', { mode: 'number' }).notNull(),
    fileId: bigint('file_id', { mode: 'number' }).notNull(),
    chunkId: text('chunk_id').notNull(),
    profileVersion: integer('profile_version').notNull(),
    embedding: vector('embedding').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('docs_chunks_binding_revision_idx').on(
      table.bindingId,
      table.revisionId,
    ),
    index('docs_chunks_binding_profile_idx').on(
      table.bindingId,
      table.profileVersion,
    ),
  ],
);
