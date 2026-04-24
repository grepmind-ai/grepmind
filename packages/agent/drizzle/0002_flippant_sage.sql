DROP TABLE "project_revision_changes" CASCADE;--> statement-breakpoint
ALTER TABLE "project_attachment_sync_state" DROP COLUMN "changes_synced";--> statement-breakpoint
ALTER TABLE "project_revision_sync_state" DROP COLUMN "changes_synced";--> statement-breakpoint
ALTER TABLE "project_revisions" DROP COLUMN "needs_changes_sync";--> statement-breakpoint
ALTER TABLE "project_revisions" DROP COLUMN "changes_cursor";--> statement-breakpoint
ALTER TABLE "project_revisions" DROP COLUMN "changes_synced_at";