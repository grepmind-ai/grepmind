import type { AgentDatabase } from './database.js';
import { projectRevisions } from './models/project-revisions.js';
import { AgentBindingTableRepository } from './table-repository.js';

export type ProjectRevisionRow = typeof projectRevisions.$inferSelect;
export type ProjectRevisionInsert = typeof projectRevisions.$inferInsert;

export class ProjectRevisionRepository extends AgentBindingTableRepository<
  typeof projectRevisions
> {
  constructor(db: AgentDatabase) {
    super(db, projectRevisions);
  }
}
