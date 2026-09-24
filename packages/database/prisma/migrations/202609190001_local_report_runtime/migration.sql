ALTER TABLE "ReportGenerationTask" ADD COLUMN "actorId" TEXT NOT NULL DEFAULT 'local',
ADD COLUMN "requestFingerprint" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ReportGenerationTask" ADD CONSTRAINT "ReportGenerationTask_artistId_fkey"
FOREIGN KEY ("artistId") REFERENCES "Artist"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TABLE "ReportScheduleCheckpoint" (
"settlementMonth" TEXT PRIMARY KEY, "artistCursor" TEXT, "enumerated" BOOLEAN NOT NULL DEFAULT false,
"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL
);
