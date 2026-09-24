import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const database = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = database;
}

export * from './money.js';
export * from './rag-index.js';
export { Prisma, PrismaClient } from '@prisma/client';
export type {
  ReportGenerationTask,
  ArtistMonthlyReport,
  MonthlyReportApproval,
} from '@prisma/client';
