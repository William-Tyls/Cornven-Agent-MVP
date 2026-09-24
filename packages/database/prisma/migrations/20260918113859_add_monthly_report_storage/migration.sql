-- CreateEnum
CREATE TYPE "public"."ReportStatus" AS ENUM ('DRAFT', 'REQUIRES_REVIEW');

-- CreateEnum
CREATE TYPE "public"."ReportTaskStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "public"."ArtistMonthlyReport" (
    "id" TEXT NOT NULL,
    "artistId" TEXT NOT NULL,
    "settlementMonth" TEXT NOT NULL,
    "asOf" TIMESTAMP(3) NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "trigger" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "isProvisional" BOOLEAN NOT NULL,
    "reportStatus" "public"."ReportStatus" NOT NULL DEFAULT 'DRAFT',
    "schemaVersion" TEXT NOT NULL,
    "reportJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArtistMonthlyReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SettlementInputSnapshot" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "m3InputJson" JSONB NOT NULL,
    "m3OutputJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SettlementInputSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ReportArtifact" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deleteReason" TEXT,

    CONSTRAINT "ReportArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ReportGenerationTask" (
    "id" TEXT NOT NULL,
    "reportId" TEXT,
    "artistId" TEXT NOT NULL,
    "settlementMonth" TEXT NOT NULL,
    "asOf" TIMESTAMP(3) NOT NULL,
    "trigger" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "status" "public"."ReportTaskStatus" NOT NULL DEFAULT 'QUEUED',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "leaseToken" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReportGenerationTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ArtistMonthlyReport_artistId_settlementMonth_idx" ON "public"."ArtistMonthlyReport"("artistId", "settlementMonth");

-- CreateIndex
CREATE UNIQUE INDEX "ArtistMonthlyReport_artistId_settlementMonth_version_key" ON "public"."ArtistMonthlyReport"("artistId", "settlementMonth", "version");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementInputSnapshot_reportId_key" ON "public"."SettlementInputSnapshot"("reportId");

-- CreateIndex
CREATE UNIQUE INDEX "ReportArtifact_storageKey_key" ON "public"."ReportArtifact"("storageKey");

-- CreateIndex
CREATE INDEX "ReportArtifact_reportId_idx" ON "public"."ReportArtifact"("reportId");

-- CreateIndex
CREATE UNIQUE INDEX "ReportGenerationTask_idempotencyKey_key" ON "public"."ReportGenerationTask"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ReportGenerationTask_status_nextRetryAt_idx" ON "public"."ReportGenerationTask"("status", "nextRetryAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReportGenerationTask_trigger_artistId_settlementMonth_key" ON "public"."ReportGenerationTask"("trigger", "artistId", "settlementMonth");

-- AddForeignKey
ALTER TABLE "public"."ArtistMonthlyReport" ADD CONSTRAINT "ArtistMonthlyReport_artistId_fkey" FOREIGN KEY ("artistId") REFERENCES "public"."Artist"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SettlementInputSnapshot" ADD CONSTRAINT "SettlementInputSnapshot_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "public"."ArtistMonthlyReport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ReportArtifact" ADD CONSTRAINT "ReportArtifact_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "public"."ArtistMonthlyReport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ReportGenerationTask" ADD CONSTRAINT "ReportGenerationTask_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "public"."ArtistMonthlyReport"("id") ON DELETE SET NULL ON UPDATE CASCADE;
