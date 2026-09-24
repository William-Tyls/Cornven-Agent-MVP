CREATE TYPE "MonthlyApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
CREATE TABLE "MonthlyReportApproval" (
  "reportId" TEXT NOT NULL PRIMARY KEY,
  "status" "MonthlyApprovalStatus" NOT NULL DEFAULT 'PENDING',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MonthlyReportApproval_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "ArtistMonthlyReport"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TABLE "MonthlyReportApprovalEvent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "reportId" TEXT NOT NULL,
  "action" "ApprovalAction" NOT NULL,
  "actorId" TEXT NOT NULL,
  "reason" TEXT,
  "requestId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MonthlyReportApprovalEvent_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "MonthlyReportApproval"("reportId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "MonthlyReportApproval_status_updatedAt_idx" ON "MonthlyReportApproval"("status", "updatedAt");
CREATE UNIQUE INDEX "MonthlyReportApprovalEvent_reportId_requestId_key" ON "MonthlyReportApprovalEvent"("reportId", "requestId");
CREATE INDEX "MonthlyReportApprovalEvent_reportId_createdAt_idx" ON "MonthlyReportApprovalEvent"("reportId", "createdAt");
