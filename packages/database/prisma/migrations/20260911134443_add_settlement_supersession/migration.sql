/*
  Warnings:

  - A unique constraint covering the columns `[supersedesRunId]` on the table `SettlementRun` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "public"."SettlementRun" ADD COLUMN     "supersedesRunId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "SettlementRun_supersedesRunId_key" ON "public"."SettlementRun"("supersedesRunId");

-- AddForeignKey
ALTER TABLE "public"."SettlementRun" ADD CONSTRAINT "SettlementRun_supersedesRunId_fkey" FOREIGN KEY ("supersedesRunId") REFERENCES "public"."SettlementRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
