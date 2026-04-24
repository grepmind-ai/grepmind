import type { PGlite } from '@electric-sql/pglite';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import { drizzle, type PgliteDatabase, type PgliteTransaction } from 'drizzle-orm/pglite';
import * as schema from './models/schema.js';

export type AgentDatabaseSchema = typeof schema;
export type AgentDatabase = PgliteDatabase<AgentDatabaseSchema>;
export type AgentDatabaseTransaction = PgliteTransaction<
  AgentDatabaseSchema,
  ExtractTablesWithRelations<AgentDatabaseSchema>
>;
export type AgentDatabaseExecutor = AgentDatabase | AgentDatabaseTransaction;

export function createAgentDatabase(client: PGlite): AgentDatabase {
  return drizzle(client, { schema });
}
