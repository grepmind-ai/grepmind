import type { AgentDatabase } from './database.js';
import { codeChunks } from './models/search-chunks.js';
import { AgentBindingTableRepository } from './table-repository.js';

export type CodeChunkRow = typeof codeChunks.$inferSelect;
export type CodeChunkInsert = typeof codeChunks.$inferInsert;

export class CodeChunkRepository extends AgentBindingTableRepository<typeof codeChunks> {
  constructor(db: AgentDatabase) {
    super(db, codeChunks);
  }
}
