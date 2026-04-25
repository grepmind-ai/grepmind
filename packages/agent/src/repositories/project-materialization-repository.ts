import type { AgentDatabase } from './database.js';
import { projectMaterializations } from './models/project-materializations.js';
import { AgentBindingTableRepository } from './table-repository.js';

export type ProjectMaterializationRow =
  typeof projectMaterializations.$inferSelect;
export type ProjectMaterializationInsert =
  typeof projectMaterializations.$inferInsert;

export class ProjectMaterializationRepository extends AgentBindingTableRepository<
  typeof projectMaterializations
> {
  constructor(db: AgentDatabase) {
    super(db, projectMaterializations);
  }
}
