ALTER TABLE "project_revision_files" ADD COLUMN "path" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX "project_revision_files_binding_revision_path_idx" ON "project_revision_files" USING btree ("binding_id","revision_id","path");--> statement-breakpoint
UPDATE "project_revisions"
SET "needs_files_sync" = TRUE,
    "files_synced_at" = NULL;--> statement-breakpoint
INSERT INTO "project_attachment_sync_state" (
  "binding_id",
  "attachment_id",
  "revision_id",
  "files_synced",
  "synced_at",
  "updated_at"
)
SELECT
  "binding_id",
  "attachment_id",
  "revision_id",
  FALSE,
  NULL,
  '1970-01-01T00:00:00.000Z'
FROM "project_revision_attachments"
ON CONFLICT ("binding_id", "attachment_id") DO UPDATE
SET "revision_id" = excluded."revision_id",
    "files_synced" = FALSE,
    "synced_at" = NULL,
    "updated_at" = excluded."updated_at";
