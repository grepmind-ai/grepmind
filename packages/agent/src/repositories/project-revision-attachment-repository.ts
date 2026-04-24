import { and, desc, eq, sql } from 'drizzle-orm';
import type { AgentDatabase } from './database.js';
import { projectRevisions } from './models/project-revisions.js';
import { projectRevisionAttachments } from './models/project-revision-attachments.js';
import { AgentBindingTableRepository } from './table-repository.js';

export type ProjectRevisionAttachmentRow = typeof projectRevisionAttachments.$inferSelect;
export type ProjectRevisionAttachmentInsert = typeof projectRevisionAttachments.$inferInsert;

export class ProjectRevisionAttachmentRepository
  extends AgentBindingTableRepository<typeof projectRevisionAttachments> {
  constructor(db: AgentDatabase) {
    super(db, projectRevisionAttachments);
  }

  async findRevisionForHead(
    bindingId: number,
    branch: string,
    commitSha: string,
  ): Promise<number | null> {
    const [row] = await this.db
      .select({
        revisionId: projectRevisionAttachments.revisionId,
      })
      .from(projectRevisionAttachments)
      .innerJoin(
        projectRevisions,
        and(
          eq(projectRevisions.bindingId, projectRevisionAttachments.bindingId),
          eq(projectRevisions.revisionId, projectRevisionAttachments.revisionId),
        ),
      )
      .where(
        and(
          eq(projectRevisionAttachments.bindingId, bindingId),
          eq(projectRevisionAttachments.branch, branch),
          eq(projectRevisions.commitSha, commitSha),
        ),
      )
      .orderBy(
        sql`case
          when ${projectRevisionAttachments.visibility} = 'binding_private' then 0
          when ${projectRevisionAttachments.visibility} = 'canonical' then 1
          else 2
        end`,
        desc(projectRevisionAttachments.attachmentId),
      )
      .limit(1);

    return row?.revisionId ?? null;
  }
}
