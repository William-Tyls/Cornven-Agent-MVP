-- DropIndex
DROP INDEX "public"."ReportGenerationTask_trigger_artistId_settlementMonth_key";

-- CreateTable
CREATE TABLE "public"."ScheduledReportLock" (
    "id" TEXT NOT NULL,
    "artistId" TEXT NOT NULL,
    "settlementMonth" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduledReportLock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ScheduledReportLock_taskId_key" ON "public"."ScheduledReportLock"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduledReportLock_artistId_settlementMonth_key" ON "public"."ScheduledReportLock"("artistId", "settlementMonth");
