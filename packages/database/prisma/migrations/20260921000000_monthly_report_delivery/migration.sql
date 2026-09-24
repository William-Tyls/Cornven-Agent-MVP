CREATE TYPE "MonthlyDeliveryStatus" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'FAILED', 'UNKNOWN', 'SKIPPED');
CREATE TABLE "ArtistDeliveryProfile" (
  "artistId" TEXT NOT NULL PRIMARY KEY, "recipientEmail" TEXT, "automaticEnabled" BOOLEAN NOT NULL DEFAULT false,
  "updatedBy" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ArtistDeliveryProfile_artistId_fkey" FOREIGN KEY ("artistId") REFERENCES "Artist"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TABLE "MonthlyDeliveryBatch" (
  "month" TEXT NOT NULL PRIMARY KEY, "scheduledAt" TIMESTAMP(3) NOT NULL, "enumerated" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "completedAt" TIMESTAMP(3)
);
CREATE TABLE "MonthlyReportDelivery" (
  "id" TEXT NOT NULL PRIMARY KEY, "artistId" TEXT NOT NULL, "reportId" TEXT, "settlementMonth" TEXT NOT NULL,
  "recipientEmail" TEXT, "trigger" TEXT NOT NULL, "mode" TEXT NOT NULL, "status" "MonthlyDeliveryStatus" NOT NULL DEFAULT 'QUEUED',
  "dedupeKey" TEXT NOT NULL, "scheduleKey" TEXT, "actorId" TEXT NOT NULL, "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "messageId" TEXT, "pdfChecksum" TEXT, "sentAt" TIMESTAMP(3), "claimedAt" TIMESTAMP(3), "errorCode" TEXT, "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MonthlyReportDelivery_artistId_fkey" FOREIGN KEY ("artistId") REFERENCES "Artist"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "MonthlyReportDelivery_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "ArtistMonthlyReport"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "MonthlyReportDelivery_dedupeKey_key" ON "MonthlyReportDelivery"("dedupeKey");
CREATE UNIQUE INDEX "MonthlyReportDelivery_scheduleKey_key" ON "MonthlyReportDelivery"("scheduleKey");
CREATE INDEX "MonthlyReportDelivery_status_createdAt_idx" ON "MonthlyReportDelivery"("status", "createdAt");
CREATE INDEX "MonthlyReportDelivery_artistId_settlementMonth_idx" ON "MonthlyReportDelivery"("artistId", "settlementMonth");
