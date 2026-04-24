CREATE TABLE "agent_meta" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "embedding_profiles" (
	"binding_id" bigint NOT NULL,
	"target" text NOT NULL,
	"profile_version" integer NOT NULL,
	"model" text NOT NULL,
	"dimensions" integer NOT NULL,
	"embedding_space" text NOT NULL,
	"artifact_schema_version" integer NOT NULL,
	"distance_metric" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "embedding_profiles_binding_id_target_pk" PRIMARY KEY("binding_id","target")
);
--> statement-breakpoint
CREATE TABLE "project_attachment_sync_state" (
	"binding_id" bigint NOT NULL,
	"attachment_id" bigint NOT NULL,
	"revision_id" bigint NOT NULL,
	"files_synced" boolean NOT NULL,
	"changes_synced" boolean NOT NULL,
	"synced_at" text,
	"updated_at" text NOT NULL,
	CONSTRAINT "project_attachment_sync_state_binding_id_attachment_id_pk" PRIMARY KEY("binding_id","attachment_id")
);
--> statement-breakpoint
CREATE TABLE "project_binding_sync_state" (
	"binding_id" bigint PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"error_message" text,
	"last_sync_started_at" text,
	"last_sync_completed_at" text,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_branches" (
	"binding_id" bigint NOT NULL,
	"repo_branch_id" bigint,
	"branch" text NOT NULL,
	"canonical_tracking_mode" text NOT NULL,
	"is_default" boolean NOT NULL,
	"viewer_tracked" boolean NOT NULL,
	"is_active_for_user" boolean NOT NULL,
	"sync_status" text NOT NULL,
	"sync_last_seen_remote_commit_sha" text,
	"sync_last_synced_commit_sha" text,
	"sync_last_sync_started_at" text,
	"sync_last_sync_completed_at" text,
	"sync_error_message" text,
	"updated_at" text NOT NULL,
	CONSTRAINT "project_branches_binding_id_branch_pk" PRIMARY KEY("binding_id","branch")
);
--> statement-breakpoint
CREATE TABLE "project_materializations" (
	"binding_id" bigint NOT NULL,
	"revision_id" bigint NOT NULL,
	"branch" text NOT NULL,
	"target" text NOT NULL,
	"profile_version" integer NOT NULL,
	"artifact_schema_version" integer NOT NULL,
	"status" text NOT NULL,
	"materialized_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "project_materializations_binding_id_revision_id_target_pk" PRIMARY KEY("binding_id","revision_id","target")
);
--> statement-breakpoint
CREATE TABLE "project_revision_attachments" (
	"binding_id" bigint NOT NULL,
	"attachment_id" bigint NOT NULL,
	"revision_id" bigint NOT NULL,
	"repo_branch_id" bigint NOT NULL,
	"branch" text NOT NULL,
	"visibility" text NOT NULL,
	"owner_binding_id" bigint,
	"source_kind" text NOT NULL,
	"attached_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "project_revision_attachments_binding_id_attachment_id_pk" PRIMARY KEY("binding_id","attachment_id")
);
--> statement-breakpoint
CREATE TABLE "project_revision_changes" (
	"binding_id" bigint NOT NULL,
	"revision_id" bigint NOT NULL,
	"change_id" bigint NOT NULL,
	"path" text NOT NULL,
	"change_type" text NOT NULL,
	"old_hash" text,
	"new_hash" text,
	"old_blob_oid" text,
	"new_blob_oid" text,
	"lang" text,
	"flags_json" text,
	"updated_at" text NOT NULL,
	CONSTRAINT "project_revision_changes_binding_id_revision_id_change_id_pk" PRIMARY KEY("binding_id","revision_id","change_id")
);
--> statement-breakpoint
CREATE TABLE "project_revision_files" (
	"binding_id" bigint NOT NULL,
	"revision_id" bigint NOT NULL,
	"file_id" bigint NOT NULL,
	"path" text NOT NULL,
	"status" text NOT NULL,
	"content_hash" text,
	"size_bytes" integer,
	"lang" text,
	"flags_json" text,
	"artifact_ref" text,
	"content_uri" text,
	"updated_at" text NOT NULL,
	CONSTRAINT "project_revision_files_binding_id_revision_id_file_id_pk" PRIMARY KEY("binding_id","revision_id","file_id")
);
--> statement-breakpoint
CREATE TABLE "project_revision_sync_state" (
	"binding_id" bigint NOT NULL,
	"revision_id" bigint NOT NULL,
	"files_synced" boolean NOT NULL,
	"changes_synced" boolean NOT NULL,
	"synced_at" text,
	"updated_at" text NOT NULL,
	CONSTRAINT "project_revision_sync_state_binding_id_revision_id_pk" PRIMARY KEY("binding_id","revision_id")
);
--> statement-breakpoint
CREATE TABLE "project_revisions" (
	"binding_id" bigint NOT NULL,
	"revision_id" bigint NOT NULL,
	"ref" text,
	"commit_sha" text NOT NULL,
	"ingested_at" text NOT NULL,
	"file_count" integer NOT NULL,
	"total_bytes" integer NOT NULL,
	"needs_files_sync" boolean NOT NULL,
	"needs_changes_sync" boolean NOT NULL,
	"files_cursor" text,
	"changes_cursor" text,
	"files_synced_at" text,
	"changes_synced_at" text,
	CONSTRAINT "project_revisions_binding_id_revision_id_pk" PRIMARY KEY("binding_id","revision_id")
);
--> statement-breakpoint
CREATE TABLE "project_sync_state" (
	"binding_id" bigint NOT NULL,
	"branch" text NOT NULL,
	"last_synced_revision_id" bigint,
	"last_materialized_code_revision_id" bigint,
	"last_materialized_docs_revision_id" bigint,
	"last_sync_started_at" text,
	"last_sync_completed_at" text,
	"status" text NOT NULL,
	"error_message" text,
	"updated_at" text NOT NULL,
	CONSTRAINT "project_sync_state_binding_id_branch_pk" PRIMARY KEY("binding_id","branch")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"binding_id" bigint PRIMARY KEY NOT NULL,
	"repo_id" bigint NOT NULL,
	"user_repo_id" bigint,
	"repo_full_name" text NOT NULL,
	"display_name" text NOT NULL,
	"workspace_path" text NOT NULL,
	"workspace_fingerprint" text,
	"default_branch" text NOT NULL,
	"active_branch" text NOT NULL,
	"last_synced_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "code_chunks" (
	"row_id" text PRIMARY KEY NOT NULL,
	"binding_id" bigint NOT NULL,
	"revision_id" bigint NOT NULL,
	"file_id" bigint NOT NULL,
	"chunk_id" text NOT NULL,
	"artifact_ref" text NOT NULL,
	"content_uri" text,
	"path" text NOT NULL,
	"language" text NOT NULL,
	"symbol_type" text,
	"symbol_name" text,
	"signature" text,
	"parent_symbol" text,
	"scope_json" text,
	"start_line" integer NOT NULL,
	"end_line" integer NOT NULL,
	"docstring" text,
	"content_hash" text NOT NULL,
	"preview_text" text NOT NULL,
	"profile_version" integer NOT NULL,
	"embedding" vector NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "docs_chunks" (
	"row_id" text PRIMARY KEY NOT NULL,
	"binding_id" bigint NOT NULL,
	"revision_id" bigint NOT NULL,
	"file_id" bigint NOT NULL,
	"chunk_id" text NOT NULL,
	"artifact_ref" text NOT NULL,
	"content_uri" text,
	"path" text NOT NULL,
	"section_title" text,
	"header_chain_json" text,
	"header_level" integer,
	"start_line" integer NOT NULL,
	"end_line" integer NOT NULL,
	"tags_json" text,
	"content_hash" text NOT NULL,
	"preview_text" text NOT NULL,
	"profile_version" integer NOT NULL,
	"embedding" vector NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "project_attachment_sync_state_binding_updated_idx" ON "project_attachment_sync_state" USING btree ("binding_id","updated_at");--> statement-breakpoint
CREATE INDEX "project_attachment_sync_state_binding_revision_idx" ON "project_attachment_sync_state" USING btree ("binding_id","revision_id","attachment_id");--> statement-breakpoint
CREATE INDEX "project_binding_sync_state_status_idx" ON "project_binding_sync_state" USING btree ("status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "project_branches_binding_repo_branch_uq" ON "project_branches" USING btree ("binding_id","repo_branch_id");--> statement-breakpoint
CREATE INDEX "project_branches_binding_active_idx" ON "project_branches" USING btree ("binding_id","is_active_for_user","is_default","branch");--> statement-breakpoint
CREATE INDEX "project_materializations_binding_target_status_revision_idx" ON "project_materializations" USING btree ("binding_id","target","status","revision_id");--> statement-breakpoint
CREATE INDEX "project_revision_attachments_binding_revision_idx" ON "project_revision_attachments" USING btree ("binding_id","revision_id","attachment_id");--> statement-breakpoint
CREATE INDEX "project_revision_attachments_binding_branch_idx" ON "project_revision_attachments" USING btree ("binding_id","branch","attachment_id");--> statement-breakpoint
CREATE INDEX "project_revision_attachments_binding_repo_branch_idx" ON "project_revision_attachments" USING btree ("binding_id","repo_branch_id","attachment_id");--> statement-breakpoint
CREATE INDEX "project_revision_changes_binding_revision_idx" ON "project_revision_changes" USING btree ("binding_id","revision_id");--> statement-breakpoint
CREATE INDEX "project_revision_files_binding_revision_idx" ON "project_revision_files" USING btree ("binding_id","revision_id");--> statement-breakpoint
CREATE INDEX "project_revision_files_binding_revision_artifact_idx" ON "project_revision_files" USING btree ("binding_id","revision_id","artifact_ref");--> statement-breakpoint
CREATE INDEX "project_revision_sync_state_binding_updated_idx" ON "project_revision_sync_state" USING btree ("binding_id","updated_at");--> statement-breakpoint
CREATE INDEX "project_revisions_binding_ingested_revision_idx" ON "project_revisions" USING btree ("binding_id","ingested_at","revision_id");--> statement-breakpoint
CREATE INDEX "project_revisions_binding_commit_idx" ON "project_revisions" USING btree ("binding_id","commit_sha");--> statement-breakpoint
CREATE INDEX "project_sync_state_binding_status_idx" ON "project_sync_state" USING btree ("binding_id","status");--> statement-breakpoint
CREATE INDEX "projects_repo_idx" ON "projects" USING btree ("repo_id");--> statement-breakpoint
CREATE INDEX "code_chunks_binding_revision_idx" ON "code_chunks" USING btree ("binding_id","revision_id");--> statement-breakpoint
CREATE INDEX "code_chunks_binding_profile_idx" ON "code_chunks" USING btree ("binding_id","profile_version");--> statement-breakpoint
CREATE INDEX "docs_chunks_binding_revision_idx" ON "docs_chunks" USING btree ("binding_id","revision_id");--> statement-breakpoint
CREATE INDEX "docs_chunks_binding_profile_idx" ON "docs_chunks" USING btree ("binding_id","profile_version");