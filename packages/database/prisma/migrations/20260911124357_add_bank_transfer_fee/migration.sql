-- AlterTable
ALTER TABLE "public"."SettlementRun" ADD COLUMN     "bankTransferFeeCents" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "finalTransferAmountCents" BIGINT;
