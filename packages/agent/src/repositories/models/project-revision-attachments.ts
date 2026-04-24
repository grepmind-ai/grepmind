import { bigint, index, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';

export const projectRevisionAttachments = pgTable(
  'project_revision_attachments',
  {
    bindingId: bigint('binding_id', { mode: 'number' }).notNull(),
    attachmentId: bigint('attachment_id', { mode: 'number' }).notNull(),
    revisionId: bigint('revision_id', { mode: 'number' }).notNull(),
    repoBranchId: bigint('repo_branch_id', { mode: 'number' }).notNull(),
    branch: text('branch').notNull(),
    visibility: text('visibility').notNull(),
    ownerBindingId: bigint('owner_binding_id', { mode: 'number' }),
    sourceKind: text('source_kind').notNull(),
    attachedAt: text('attached_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.bindingId, table.attachmentId] }),
    index('project_revision_attachments_binding_revision_idx').on(
      table.bindingId,
      table.revisionId,
      table.attachmentId,
    ),
    index('project_revision_attachments_binding_branch_idx').on(
      table.bindingId,
      table.branch,
      table.attachmentId,
    ),
    index('project_revision_attachments_binding_repo_branch_idx').on(
      table.bindingId,
      table.repoBranchId,
      table.attachmentId,
    ),
  ],
);
