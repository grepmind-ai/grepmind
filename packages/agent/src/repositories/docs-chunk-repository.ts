import type { AgentDatabase } from './database.js';
import { docsChunks } from './models/search-chunks.js';
import { AgentBindingTableRepository } from './table-repository.js';

export type DocsChunkRow = typeof docsChunks.$inferSelect;
export type DocsChunkInsert = typeof docsChunks.$inferInsert;

export class DocsChunkRepository extends AgentBindingTableRepository<
  typeof docsChunks
> {
  constructor(db: AgentDatabase) {
    super(db, docsChunks);
  }
}
