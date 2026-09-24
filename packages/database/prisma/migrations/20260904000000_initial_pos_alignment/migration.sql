-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- Required by DocumentChunk.embedding.
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateEnum
CREATE TYPE "public"."UserRole" AS ENUM ('STAFF');

-- CreateEnum
CREATE TYPE "public"."ImportSource" AS ENUM ('MOCK', 'CSV', 'POS_API', 'POS_DATABASE');

-- CreateEnum
CREATE TYPE "public"."ImportStatus" AS ENUM ('UPLOADED', 'VALIDATING', 'VALIDATED', 'IMPORTED', 'FAILED');

-- CreateEnum
CREATE TYPE "public"."RawRecordStatus" AS ENUM ('RECEIVED', 'VALID', 'INVALID', 'NORMALIZED');

-- CreateEnum
CREATE TYPE "public"."RawRecordType" AS ENUM ('SALE', 'REFUND', 'EXCHANGE');

-- CreateEnum
CREATE TYPE "public"."CommissionRateSource" AS ENUM ('RENTAL');

-- CreateEnum
CREATE TYPE "public"."RuleStatus" AS ENUM ('DRAFT', 'ACTIVE', 'RETIRED');

-- CreateEnum
CREATE TYPE "public"."SettlementStatus" AS ENUM ('DRAFT', 'CALCULATED', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'LOCKED', 'EXPORTED');

-- CreateEnum
CREATE TYPE "public"."ApprovalAction" AS ENUM ('SUBMIT', 'APPROVE', 'REJECT');

-- CreateEnum
CREATE TYPE "public"."DeliveryStatus" AS ENUM ('DRAFT', 'READY', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "public"."User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "role" "public"."UserRole" NOT NULL DEFAULT 'STAFF',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Artist" (
    "id" TEXT NOT NULL,
    "externalRef" TEXT,
    "name" TEXT NOT NULL,
    "brandName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Artist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Venue" (
    "id" TEXT NOT NULL,
    "externalRef" TEXT,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Australia/Sydney',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Venue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Product" (
    "id" TEXT NOT NULL,
    "externalRef" TEXT,
    "artistId" TEXT NOT NULL,
    "sku" TEXT,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ImportBatch" (
    "id" TEXT NOT NULL,
    "source" "public"."ImportSource" NOT NULL,
    "status" "public"."ImportStatus" NOT NULL DEFAULT 'UPLOADED',
    "sourceFileName" TEXT,
    "checksum" TEXT NOT NULL,
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "validRows" INTEGER NOT NULL DEFAULT 0,
    "invalidRows" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."RawPosRecord" (
    "id" TEXT NOT NULL,
    "importBatchId" TEXT NOT NULL,
    "sourceRecordId" TEXT NOT NULL,
    "sourceTransactionId" TEXT NOT NULL,
    "parentTransactionId" TEXT,
    "recordType" "public"."RawRecordType" NOT NULL,
    "canonicalSaleId" TEXT,
    "quantity" INTEGER,
    "unitPriceCents" BIGINT,
    "totalAmountCents" BIGINT,
    "commissionAmountCents" BIGINT,
    "tenantAmountCents" BIGINT,
    "rentalExternalRef" TEXT,
    "cubeExternalRef" TEXT,
    "rentalRateRaw" TEXT,
    "cubeRateRaw" TEXT,
    "checksum" TEXT NOT NULL,
    "rawPayload" JSONB NOT NULL,
    "status" "public"."RawRecordStatus" NOT NULL DEFAULT 'RECEIVED',
    "occurredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RawPosRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ImportError" (
    "id" TEXT NOT NULL,
    "importBatchId" TEXT NOT NULL,
    "rowNumber" INTEGER,
    "field" TEXT,
    "code" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "rawValue" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportError_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Rental" (
    "id" TEXT NOT NULL,
    "externalRef" TEXT NOT NULL,
    "artistId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "cubeExternalRef" TEXT,
    "commissionBps" INTEGER NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Rental_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Sale" (
    "id" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "sourceRecordId" TEXT NOT NULL,
    "sourceTransactionId" TEXT NOT NULL,
    "importBatchId" TEXT NOT NULL,
    "artistId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "rentalId" TEXT NOT NULL,
    "cubeExternalRef" TEXT,
    "soldAt" TIMESTAMP(3) NOT NULL,
    "quantitySold" INTEGER NOT NULL,
    "unitPriceCents" BIGINT NOT NULL,
    "grossSalesCents" BIGINT NOT NULL,
    "refundAmountCents" BIGINT NOT NULL DEFAULT 0,
    "sourceCommissionAmountCents" BIGINT NOT NULL,
    "sourceTenantAmountCents" BIGINT NOT NULL,
    "rentalCommissionBps" INTEGER NOT NULL,
    "cubeCommissionBps" INTEGER,
    "currency" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Sale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."InventorySnapshot" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventorySnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SettlementRuleVersion" (
    "id" TEXT NOT NULL,
    "rentalId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "rentalCommissionBps" INTEGER NOT NULL,
    "rateSource" "public"."CommissionRateSource" NOT NULL DEFAULT 'RENTAL',
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "status" "public"."RuleStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SettlementRuleVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SettlementRun" (
    "id" TEXT NOT NULL,
    "artistId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "rentalId" TEXT NOT NULL,
    "ruleVersionId" TEXT NOT NULL,
    "rateSource" "public"."CommissionRateSource" NOT NULL DEFAULT 'RENTAL',
    "rentalCommissionBps" INTEGER NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "businessTimezone" TEXT NOT NULL DEFAULT 'Australia/Sydney',
    "inputSnapshotRef" TEXT NOT NULL,
    "status" "public"."SettlementStatus" NOT NULL DEFAULT 'DRAFT',
    "totalSalesCents" BIGINT NOT NULL,
    "refundAmountCents" BIGINT NOT NULL,
    "netSalesCents" BIGINT NOT NULL,
    "sourceCommissionAmountCents" BIGINT NOT NULL,
    "sourceTenantAmountCents" BIGINT NOT NULL,
    "calculatedCommissionAmountCents" BIGINT NOT NULL,
    "calculatedTenantAmountCents" BIGINT NOT NULL,
    "commissionDifferenceCents" BIGINT NOT NULL,
    "tenantDifferenceCents" BIGINT NOT NULL,
    "amountPayableCents" BIGINT NOT NULL,
    "requiresReview" BOOLEAN NOT NULL DEFAULT false,
    "currency" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SettlementRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SettlementLine" (
    "id" TEXT NOT NULL,
    "settlementRunId" TEXT NOT NULL,
    "productId" TEXT,
    "sku" TEXT,
    "productName" TEXT NOT NULL,
    "quantitySold" INTEGER NOT NULL,
    "grossSalesCents" BIGINT NOT NULL,
    "refundAmountCents" BIGINT NOT NULL,
    "netSalesCents" BIGINT NOT NULL,
    "sourceCommissionAmountCents" BIGINT NOT NULL,
    "sourceTenantAmountCents" BIGINT NOT NULL,
    "calculatedCommissionAmountCents" BIGINT NOT NULL,
    "calculatedTenantAmountCents" BIGINT NOT NULL,
    "commissionDifferenceCents" BIGINT NOT NULL,
    "tenantDifferenceCents" BIGINT NOT NULL,

    CONSTRAINT "SettlementLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ApprovalEvent" (
    "id" TEXT NOT NULL,
    "settlementRunId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" "public"."ApprovalAction" NOT NULL,
    "reason" TEXT,
    "requestId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ReportDelivery" (
    "id" TEXT NOT NULL,
    "settlementRunId" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "status" "public"."DeliveryStatus" NOT NULL DEFAULT 'DRAFT',
    "fileChecksum" TEXT,
    "sentAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReportDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Document" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "businessVersion" TEXT,
    "checksum" TEXT NOT NULL,
    "permissionTags" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."DocumentChunk" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "locator" TEXT NOT NULL,
    "embedding" vector,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."AuditEvent" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "actorType" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "requestId" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "public"."User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Artist_externalRef_key" ON "public"."Artist"("externalRef");

-- CreateIndex
CREATE UNIQUE INDEX "Venue_externalRef_key" ON "public"."Venue"("externalRef");

-- CreateIndex
CREATE UNIQUE INDEX "Product_externalRef_key" ON "public"."Product"("externalRef");

-- CreateIndex
CREATE INDEX "Product_artistId_idx" ON "public"."Product"("artistId");

-- CreateIndex
CREATE UNIQUE INDEX "Product_artistId_sku_key" ON "public"."Product"("artistId", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "ImportBatch_checksum_key" ON "public"."ImportBatch"("checksum");

-- CreateIndex
CREATE INDEX "RawPosRecord_sourceTransactionId_idx" ON "public"."RawPosRecord"("sourceTransactionId");

-- CreateIndex
CREATE INDEX "RawPosRecord_parentTransactionId_idx" ON "public"."RawPosRecord"("parentTransactionId");

-- CreateIndex
CREATE INDEX "RawPosRecord_canonicalSaleId_idx" ON "public"."RawPosRecord"("canonicalSaleId");

-- CreateIndex
CREATE UNIQUE INDEX "RawPosRecord_importBatchId_sourceRecordId_key" ON "public"."RawPosRecord"("importBatchId", "sourceRecordId");

-- CreateIndex
CREATE UNIQUE INDEX "RawPosRecord_importBatchId_checksum_key" ON "public"."RawPosRecord"("importBatchId", "checksum");

-- CreateIndex
CREATE INDEX "ImportError_importBatchId_idx" ON "public"."ImportError"("importBatchId");

-- CreateIndex
CREATE UNIQUE INDEX "Rental_externalRef_key" ON "public"."Rental"("externalRef");

-- CreateIndex
CREATE INDEX "Rental_artistId_effectiveFrom_effectiveTo_idx" ON "public"."Rental"("artistId", "effectiveFrom", "effectiveTo");

-- CreateIndex
CREATE INDEX "Rental_venueId_effectiveFrom_effectiveTo_idx" ON "public"."Rental"("venueId", "effectiveFrom", "effectiveTo");

-- CreateIndex
CREATE UNIQUE INDEX "Sale_dedupeKey_key" ON "public"."Sale"("dedupeKey");

-- CreateIndex
CREATE INDEX "Sale_artistId_soldAt_idx" ON "public"."Sale"("artistId", "soldAt");

-- CreateIndex
CREATE INDEX "Sale_venueId_soldAt_idx" ON "public"."Sale"("venueId", "soldAt");

-- CreateIndex
CREATE INDEX "Sale_productId_soldAt_idx" ON "public"."Sale"("productId", "soldAt");

-- CreateIndex
CREATE INDEX "Sale_rentalId_soldAt_idx" ON "public"."Sale"("rentalId", "soldAt");

-- CreateIndex
CREATE INDEX "Sale_sourceTransactionId_idx" ON "public"."Sale"("sourceTransactionId");

-- CreateIndex
CREATE INDEX "InventorySnapshot_venueId_capturedAt_idx" ON "public"."InventorySnapshot"("venueId", "capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "InventorySnapshot_productId_venueId_capturedAt_key" ON "public"."InventorySnapshot"("productId", "venueId", "capturedAt");

-- CreateIndex
CREATE INDEX "SettlementRuleVersion_rentalId_effectiveFrom_effectiveTo_idx" ON "public"."SettlementRuleVersion"("rentalId", "effectiveFrom", "effectiveTo");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementRuleVersion_rentalId_version_key" ON "public"."SettlementRuleVersion"("rentalId", "version");

-- CreateIndex
CREATE INDEX "SettlementRun_artistId_periodStart_periodEnd_idx" ON "public"."SettlementRun"("artistId", "periodStart", "periodEnd");

-- CreateIndex
CREATE INDEX "SettlementRun_rentalId_periodStart_periodEnd_idx" ON "public"."SettlementRun"("rentalId", "periodStart", "periodEnd");

-- CreateIndex
CREATE INDEX "SettlementRun_status_idx" ON "public"."SettlementRun"("status");

-- CreateIndex
CREATE INDEX "SettlementLine_settlementRunId_idx" ON "public"."SettlementLine"("settlementRunId");

-- CreateIndex
CREATE INDEX "ApprovalEvent_settlementRunId_createdAt_idx" ON "public"."ApprovalEvent"("settlementRunId", "createdAt");

-- CreateIndex
CREATE INDEX "ReportDelivery_settlementRunId_idx" ON "public"."ReportDelivery"("settlementRunId");

-- CreateIndex
CREATE UNIQUE INDEX "Document_checksum_key" ON "public"."Document"("checksum");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentChunk_documentId_ordinal_key" ON "public"."DocumentChunk"("documentId", "ordinal");

-- CreateIndex
CREATE INDEX "AuditEvent_requestId_idx" ON "public"."AuditEvent"("requestId");

-- CreateIndex
CREATE INDEX "AuditEvent_entityType_entityId_idx" ON "public"."AuditEvent"("entityType", "entityId");

-- AddForeignKey
ALTER TABLE "public"."Product" ADD CONSTRAINT "Product_artistId_fkey" FOREIGN KEY ("artistId") REFERENCES "public"."Artist"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RawPosRecord" ADD CONSTRAINT "RawPosRecord_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "public"."ImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RawPosRecord" ADD CONSTRAINT "RawPosRecord_canonicalSaleId_fkey" FOREIGN KEY ("canonicalSaleId") REFERENCES "public"."Sale"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ImportError" ADD CONSTRAINT "ImportError_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "public"."ImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Rental" ADD CONSTRAINT "Rental_artistId_fkey" FOREIGN KEY ("artistId") REFERENCES "public"."Artist"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Rental" ADD CONSTRAINT "Rental_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Sale" ADD CONSTRAINT "Sale_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "public"."ImportBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Sale" ADD CONSTRAINT "Sale_artistId_fkey" FOREIGN KEY ("artistId") REFERENCES "public"."Artist"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Sale" ADD CONSTRAINT "Sale_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Sale" ADD CONSTRAINT "Sale_productId_fkey" FOREIGN KEY ("productId") REFERENCES "public"."Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Sale" ADD CONSTRAINT "Sale_rentalId_fkey" FOREIGN KEY ("rentalId") REFERENCES "public"."Rental"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."InventorySnapshot" ADD CONSTRAINT "InventorySnapshot_productId_fkey" FOREIGN KEY ("productId") REFERENCES "public"."Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."InventorySnapshot" ADD CONSTRAINT "InventorySnapshot_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SettlementRuleVersion" ADD CONSTRAINT "SettlementRuleVersion_rentalId_fkey" FOREIGN KEY ("rentalId") REFERENCES "public"."Rental"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SettlementRun" ADD CONSTRAINT "SettlementRun_artistId_fkey" FOREIGN KEY ("artistId") REFERENCES "public"."Artist"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SettlementRun" ADD CONSTRAINT "SettlementRun_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SettlementRun" ADD CONSTRAINT "SettlementRun_rentalId_fkey" FOREIGN KEY ("rentalId") REFERENCES "public"."Rental"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SettlementRun" ADD CONSTRAINT "SettlementRun_ruleVersionId_fkey" FOREIGN KEY ("ruleVersionId") REFERENCES "public"."SettlementRuleVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SettlementLine" ADD CONSTRAINT "SettlementLine_settlementRunId_fkey" FOREIGN KEY ("settlementRunId") REFERENCES "public"."SettlementRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SettlementLine" ADD CONSTRAINT "SettlementLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "public"."Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ApprovalEvent" ADD CONSTRAINT "ApprovalEvent_settlementRunId_fkey" FOREIGN KEY ("settlementRunId") REFERENCES "public"."SettlementRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ApprovalEvent" ADD CONSTRAINT "ApprovalEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ReportDelivery" ADD CONSTRAINT "ReportDelivery_settlementRunId_fkey" FOREIGN KEY ("settlementRunId") REFERENCES "public"."SettlementRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."DocumentChunk" ADD CONSTRAINT "DocumentChunk_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "public"."Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AuditEvent" ADD CONSTRAINT "AuditEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Domain constraints that Prisma cannot express in schema.prisma.
ALTER TABLE "public"."ImportBatch"
  ADD CONSTRAINT "ImportBatch_row_counts_check"
  CHECK (
    "totalRows" >= 0 AND "validRows" >= 0 AND "invalidRows" >= 0
    AND "validRows" + "invalidRows" <= "totalRows"
  );

ALTER TABLE "public"."RawPosRecord"
  ADD CONSTRAINT "RawPosRecord_shape_check"
  CHECK (
    "status" NOT IN ('VALID', 'NORMALIZED')
    OR (
      "recordType" = 'SALE'
      AND "parentTransactionId" IS NULL
      AND "quantity" IS NOT NULL
      AND "unitPriceCents" IS NOT NULL
      AND "totalAmountCents" IS NOT NULL
      AND "commissionAmountCents" IS NOT NULL
      AND "tenantAmountCents" IS NOT NULL
      AND "quantity" > 0
      AND "unitPriceCents" > 0
      AND "totalAmountCents" >= 0
      AND "commissionAmountCents" >= 0
      AND "tenantAmountCents" >= 0
      AND "commissionAmountCents" + "tenantAmountCents" = "totalAmountCents"
    )
    OR (
      "recordType" = 'REFUND'
      AND "parentTransactionId" IS NOT NULL
      AND "quantity" IS NOT NULL
      AND "unitPriceCents" IS NOT NULL
      AND "totalAmountCents" IS NOT NULL
      AND "commissionAmountCents" IS NOT NULL
      AND "tenantAmountCents" IS NOT NULL
      AND "quantity" < 0
      AND "unitPriceCents" > 0
      AND "totalAmountCents" < 0
      AND "commissionAmountCents" <= 0
      AND "tenantAmountCents" <= 0
      AND "commissionAmountCents" + "tenantAmountCents" = "totalAmountCents"
    )
    OR (
      "recordType" = 'EXCHANGE'
      AND "quantity" IS NOT NULL
      AND "quantity" > 0
      AND "totalAmountCents" IS NULL
      AND "unitPriceCents" IS NULL
      AND "commissionAmountCents" IS NULL
      AND "tenantAmountCents" IS NULL
    )
  );

ALTER TABLE "public"."Rental"
  ADD CONSTRAINT "Rental_commission_range_check"
  CHECK ("commissionBps" BETWEEN 0 AND 10000),
  ADD CONSTRAINT "Rental_effective_period_check"
  CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom");

ALTER TABLE "public"."Sale"
  ADD CONSTRAINT "Sale_positive_quantity_check"
  CHECK ("quantitySold" > 0),
  ADD CONSTRAINT "Sale_amounts_check"
  CHECK (
    "unitPriceCents" > 0
    AND "grossSalesCents" >= 0
    AND "refundAmountCents" >= 0
    AND "refundAmountCents" <= "grossSalesCents"
    AND "sourceCommissionAmountCents" >= 0
    AND "sourceTenantAmountCents" >= 0
    AND "sourceCommissionAmountCents" + "sourceTenantAmountCents"
      = "grossSalesCents" - "refundAmountCents"
  ),
  ADD CONSTRAINT "Sale_rate_range_check"
  CHECK (
    "rentalCommissionBps" BETWEEN 0 AND 10000
    AND ("cubeCommissionBps" IS NULL OR "cubeCommissionBps" BETWEEN 0 AND 10000)
  );

ALTER TABLE "public"."InventorySnapshot"
  ADD CONSTRAINT "InventorySnapshot_quantity_check"
  CHECK ("quantity" >= 0);

ALTER TABLE "public"."SettlementRuleVersion"
  ADD CONSTRAINT "SettlementRuleVersion_version_check"
  CHECK ("version" > 0),
  ADD CONSTRAINT "SettlementRuleVersion_rate_range_check"
  CHECK ("rentalCommissionBps" BETWEEN 0 AND 10000),
  ADD CONSTRAINT "SettlementRuleVersion_effective_period_check"
  CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom");

ALTER TABLE "public"."SettlementRun"
  ADD CONSTRAINT "SettlementRun_period_check"
  CHECK ("periodEnd" >= "periodStart"),
  ADD CONSTRAINT "SettlementRun_rate_range_check"
  CHECK ("rentalCommissionBps" BETWEEN 0 AND 10000),
  ADD CONSTRAINT "SettlementRun_amounts_check"
  CHECK (
    "totalSalesCents" >= 0
    AND "refundAmountCents" >= 0
    AND "refundAmountCents" <= "totalSalesCents"
    AND "netSalesCents" = "totalSalesCents" - "refundAmountCents"
    AND "sourceCommissionAmountCents" >= 0
    AND "sourceTenantAmountCents" >= 0
    AND "sourceCommissionAmountCents" + "sourceTenantAmountCents" = "netSalesCents"
    AND "calculatedCommissionAmountCents" >= 0
    AND "calculatedCommissionAmountCents" <= "netSalesCents"
    AND "calculatedTenantAmountCents" = "netSalesCents" - "calculatedCommissionAmountCents"
    AND "commissionDifferenceCents" = "sourceCommissionAmountCents" - "calculatedCommissionAmountCents"
    AND "tenantDifferenceCents" = "sourceTenantAmountCents" - "calculatedTenantAmountCents"
    AND "amountPayableCents" = "calculatedTenantAmountCents"
  );

ALTER TABLE "public"."SettlementLine"
  ADD CONSTRAINT "SettlementLine_positive_quantity_check"
  CHECK ("quantitySold" > 0),
  ADD CONSTRAINT "SettlementLine_amounts_check"
  CHECK (
    "grossSalesCents" >= 0
    AND "refundAmountCents" >= 0
    AND "refundAmountCents" <= "grossSalesCents"
    AND "netSalesCents" = "grossSalesCents" - "refundAmountCents"
    AND "sourceCommissionAmountCents" >= 0
    AND "sourceTenantAmountCents" >= 0
    AND "sourceCommissionAmountCents" + "sourceTenantAmountCents" = "netSalesCents"
    AND "calculatedCommissionAmountCents" >= 0
    AND "calculatedCommissionAmountCents" <= "netSalesCents"
    AND "calculatedTenantAmountCents" = "netSalesCents" - "calculatedCommissionAmountCents"
    AND "commissionDifferenceCents" = "sourceCommissionAmountCents" - "calculatedCommissionAmountCents"
    AND "tenantDifferenceCents" = "sourceTenantAmountCents" - "calculatedTenantAmountCents"
  );
