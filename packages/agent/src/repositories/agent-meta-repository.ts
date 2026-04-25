import type { AgentDatabase } from './database.js';
import { agentMeta } from './models/agent-meta.js';
import { AgentTableRepository } from './table-repository.js';

export type AgentMetaRow = typeof agentMeta.$inferSelect;
export type AgentMetaInsert = typeof agentMeta.$inferInsert;

export class AgentMetaRepository extends AgentTableRepository<
  typeof agentMeta
> {
  constructor(db: AgentDatabase) {
    super(db, agentMeta);
  }
}
