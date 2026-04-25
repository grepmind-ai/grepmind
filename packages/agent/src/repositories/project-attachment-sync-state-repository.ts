import type { AgentDatabase } from './database.js';
import { projectAttachmentSyncState } from './models/project-attachment-sync-state.js';
import { AgentBindingTableRepository } from './table-repository.js';

export type ProjectAttachmentSyncStateRow =
  typeof projectAttachmentSyncState.$inferSelect;
export type ProjectAttachmentSyncStateInsert =
  typeof projectAttachmentSyncState.$inferInsert;

export class ProjectAttachmentSyncStateRepository extends AgentBindingTableRepository<
  typeof projectAttachmentSyncState
> {
  constructor(db: AgentDatabase) {
    super(db, projectAttachmentSyncState);
  }
}
