import { pgTable, text } from 'drizzle-orm/pg-core';

export const agentMeta = pgTable('agent_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
});
