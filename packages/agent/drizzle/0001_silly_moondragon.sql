ALTER TABLE "project_revision_changes" DROP COLUMN "old_hash";--> statement-breakpoint
ALTER TABLE "project_revision_changes" DROP COLUMN "new_hash";--> statement-breakpoint
ALTER TABLE "project_revision_changes" DROP COLUMN "old_blob_oid";--> statement-breakpoint
ALTER TABLE "project_revision_changes" DROP COLUMN "new_blob_oid";--> statement-breakpoint
ALTER TABLE "project_revision_changes" DROP COLUMN "lang";--> statement-breakpoint
ALTER TABLE "project_revision_changes" DROP COLUMN "flags_json";