CREATE TABLE "docs_chunk_tags" (
	"row_id" text NOT NULL,
	"binding_id" bigint NOT NULL,
	"revision_id" bigint NOT NULL,
	"file_id" bigint NOT NULL,
	"chunk_id" text NOT NULL,
	"tag" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "docs_chunk_tags_row_id_tag_pk" PRIMARY KEY("row_id","tag")
);
--> statement-breakpoint
CREATE INDEX "docs_chunk_tags_binding_revision_tag_idx" ON "docs_chunk_tags" USING btree ("binding_id","revision_id","tag");
--> statement-breakpoint
CREATE INDEX "docs_chunk_tags_binding_revision_chunk_idx" ON "docs_chunk_tags" USING btree ("binding_id","revision_id","file_id","chunk_id");
