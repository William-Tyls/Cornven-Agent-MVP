-- AlterTable
ALTER TABLE "public"."Sale" ADD COLUMN     "parentSaleId" TEXT,
ADD COLUMN     "recordType" "public"."RawRecordType" NOT NULL DEFAULT 'SALE';

-- CreateIndex
CREATE INDEX "Sale_parentSaleId_idx" ON "public"."Sale"("parentSaleId");

-- AddForeignKey
ALTER TABLE "public"."Sale" ADD CONSTRAINT "Sale_parentSaleId_fkey" FOREIGN KEY ("parentSaleId") REFERENCES "public"."Sale"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Refunds/exchanges are now separate adjustment records (recordType = REFUND/EXCHANGE)
-- linked back to their original sale via parentSaleId, instead of mutating the
-- original Sale row. This means quantity/amount signs differ by recordType:
-- a SALE row must be positive; a REFUND/EXCHANGE adjustment row may be negative.
ALTER TABLE "public"."Sale" DROP CONSTRAINT "Sale_positive_quantity_check";
ALTER TABLE "public"."Sale" DROP CONSTRAINT "Sale_amounts_check";

ALTER TABLE "public"."Sale"
  ADD CONSTRAINT "Sale_quantity_sign_check"
  CHECK (
    ("recordType" = 'SALE' AND "quantitySold" > 0)
    OR ("recordType" IN ('REFUND', 'EXCHANGE') AND "quantitySold" < 0)
  ),
  ADD CONSTRAINT "Sale_amounts_check"
  CHECK (
    "unitPriceCents" > 0
    AND "refundAmountCents" = 0
    AND "sourceCommissionAmountCents" + "sourceTenantAmountCents" = "grossSalesCents"
  );
