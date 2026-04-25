import {
  bigint,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
} from 'drizzle-orm/pg-core';

export const projectMaterializations = pgTable(
  'project_materializations',
  {
    bindingId: bigint('binding_id', { mode: 'number' }).notNull(),
    revisionId: bigint('revision_id', { mode: 'number' }).notNull(),
    branch: text('branch').notNull(),
    target: text('target').notNull(),
    profileVersion: integer('profile_version').notNull(),
    artifactSchemaVersion: integer('artifact_schema_version').notNull(),
    status: text('status').notNull(),
    materializedAt: text('materialized_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.bindingId, table.revisionId, table.target] }),
    index('project_materializations_binding_target_status_revision_idx').on(
      table.bindingId,
      table.target,
      table.status,
      table.revisionId,
    ),
  ],
);
