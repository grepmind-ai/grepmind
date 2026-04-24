import { bigint, integer, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';

export const embeddingProfiles = pgTable(
  'embedding_profiles',
  {
    bindingId: bigint('binding_id', { mode: 'number' }).notNull(),
    target: text('target').notNull(),
    profileVersion: integer('profile_version').notNull(),
    model: text('model').notNull(),
    dimensions: integer('dimensions').notNull(),
    embeddingSpace: text('embedding_space').notNull(),
    artifactSchemaVersion: integer('artifact_schema_version').notNull(),
    distanceMetric: text('distance_metric').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.bindingId, table.target] }),
  ],
);
