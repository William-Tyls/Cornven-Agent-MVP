-- Store stable source metadata so an approved document can be re-indexed without changing identity.
ALTER TABLE "public"."Document"
ADD COLUMN "sourceId" TEXT,
ADD COLUMN "sourceType" TEXT NOT NULL DEFAULT 'legacy_unknown',
ADD COLUMN "sourceUrl" TEXT NOT NULL DEFAULT '',
ADD COLUMN "contentStatus" TEXT NOT NULL DEFAULT 'legacy_unknown',
ADD COLUMN "audience" TEXT NOT NULL DEFAULT 'staff_internal',
ADD COLUMN "retrievalStatus" TEXT NOT NULL DEFAULT 'disabled',
ADD COLUMN "indexedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "public"."Document" SET "sourceId" = "id" WHERE "sourceId" IS NULL;
ALTER TABLE "public"."Document" ALTER COLUMN "sourceId" SET NOT NULL;
ALTER TABLE "public"."Document" ALTER COLUMN "retrievalStatus" SET DEFAULT 'active';

-- Preserve any pre-existing scaffold rows, then make every new chunk self-describing and auditable.
ALTER TABLE "public"."DocumentChunk"
ADD COLUMN "headingPath" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "checksum" TEXT,
ADD COLUMN "embeddingModel" TEXT NOT NULL DEFAULT 'legacy_unknown',
ADD COLUMN "embeddingDimensions" INTEGER NOT NULL DEFAULT 256;

UPDATE "public"."DocumentChunk"
SET "checksum" = md5("content" || ':' || "ordinal"::TEXT),
    "headingPath" = ARRAY["locator"]
WHERE "checksum" IS NULL;

ALTER TABLE "public"."DocumentChunk" ALTER COLUMN "checksum" SET NOT NULL;
ALTER TABLE "public"."DocumentChunk"
ALTER COLUMN "embedding" TYPE vector(256)
USING "embedding"::vector(256);

CREATE UNIQUE INDEX "Document_sourceId_key" ON "public"."Document"("sourceId");
CREATE UNIQUE INDEX "DocumentChunk_documentId_checksum_key"
ON "public"."DocumentChunk"("documentId", "checksum");
CREATE INDEX "Document_permissionTags_gin_idx"
ON "public"."Document" USING GIN ("permissionTags");
CREATE INDEX "DocumentChunk_embedding_hnsw_idx"
ON "public"."DocumentChunk" USING hnsw ("embedding" vector_cosine_ops)
WHERE "embedding" IS NOT NULL;

ALTER TABLE "public"."Document"
ADD CONSTRAINT "Document_permission_tags_check" CHECK (cardinality("permissionTags") > 0),
ADD CONSTRAINT "Document_retrieval_status_check" CHECK ("retrievalStatus" IN ('active', 'disabled'));

ALTER TABLE "public"."DocumentChunk"
ADD CONSTRAINT "DocumentChunk_ordinal_check" CHECK ("ordinal" >= 0),
ADD CONSTRAINT "DocumentChunk_content_check" CHECK (length(btrim("content")) > 0),
ADD CONSTRAINT "DocumentChunk_locator_check" CHECK (length(btrim("locator")) > 0),
ADD CONSTRAINT "DocumentChunk_embedding_dimensions_check" CHECK ("embeddingDimensions" = 256);
