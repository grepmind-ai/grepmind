import type { AgentDatabase } from './database.js';
import { projectRevisionFiles } from './models/project-revision-files.js';
import { AgentBindingTableRepository } from './table-repository.js';

export type ProjectRevisionFileRow = typeof projectRevisionFiles.$inferSelect;
export type ProjectRevisionFileInsert =
  typeof projectRevisionFiles.$inferInsert;

export class ProjectRevisionFileRepository extends AgentBindingTableRepository<
  typeof projectRevisionFiles
> {
  constructor(db: AgentDatabase) {
    super(db, projectRevisionFiles);
  }
}
