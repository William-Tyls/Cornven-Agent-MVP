-- OpenAI text-embedding-3-large is configured to return 1024 dimensions.
-- Existing vectors cannot be mixed with the new model/dimension and must be regenerated.
DROP INDEX IF EXISTS "public"."DocumentChunk_embedding_hnsw_idx";

ALTER TABLE "public"."DocumentChunk"
DROP CONSTRAINT IF EXISTS "DocumentChunk_embedding_dimensions_check";

UPDATE "public"."DocumentChunk"
SET "embedding" = NULL,
    "embeddingModel" = 'pending_reindex',
    "embeddingDimensions" = 1024;

ALTER TABLE "public"."DocumentChunk"
ALTER COLUMN "embeddingDimensions" SET DEFAULT 1024,
ALTER COLUMN "embedding" TYPE vector(1024)
USING NULL::vector(1024);

ALTER TABLE "public"."DocumentChunk"
ADD CONSTRAINT "DocumentChunk_embedding_dimensions_check" CHECK ("embeddingDimensions" = 1024);

CREATE INDEX "DocumentChunk_embedding_hnsw_idx"
ON "public"."DocumentChunk" USING hnsw ("embedding" vector_cosine_ops)
WHERE "embedding" IS NOT NULL;
