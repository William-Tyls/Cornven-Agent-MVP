import { z } from 'zod';
import { contextPolicy } from '../documents/context-policy.js';
import { MonthlyReportDocumentSchema, type DocumentPermissionTag } from '@cornven/contracts';
import type { ReportRuntime } from '../reporting/report-runtime.js';
import type { ReportActor } from '../../shared/report-auth.js';
import { requireArtist } from '../../shared/report-auth.js';
import { ReportError } from '../../shared/report-errors.js';
import { documentsService } from '../documents/documents.routes.js';
import type { AssistantTools } from './assistant.service.js';

/** Narrow read-only adapter: never exposes report generation or arbitrary SQL to the model. */
export function createAssistantTools(
  reports: ReportRuntime,
  actor: ReportActor,
  permissionTags: DocumentPermissionTag[],
): AssistantTools {
  const db = reports.repository.db;
  return {
    async resolveArtists(query) {
      const visible = actor.artistIds === '*' ? {} : { id: { in: [...actor.artistIds] } };
      const fields = { id: true, name: true, brandName: true, externalRef: true } as const;
      const exact = await db.artist.findMany({
        where: {
          AND: [
            visible,
            {
              OR: [
                ...(z.string().uuid().safeParse(query).success ? [{ id: query }] : []),
                { externalRef: { equals: query, mode: 'insensitive' as const } },
                { name: { equals: query, mode: 'insensitive' as const } },
                { brandName: { equals: query, mode: 'insensitive' as const } },
              ],
            },
          ],
        },
        select: fields,
        take: 6,
        orderBy: { id: 'asc' },
      });
      if (exact.length) return exact;
      return db.artist.findMany({
        where: {
          AND: [
            visible,
            {
              OR: [
                { name: { contains: query, mode: 'insensitive' } },
                { brandName: { contains: query, mode: 'insensitive' } },
              ],
            },
          ],
        },
        select: fields,
        take: 6,
        orderBy: { id: 'asc' },
      });
    },
    async searchSales(artistId, settlementMonth) {
      requireArtist(actor, artistId);
      return reports.refunds.search({ artistId, settlementMonth });
    },
    async preview(artistId, settlementMonth) {
      requireArtist(actor, artistId);
      return reports.preview.preview({ artistId, settlementMonth });
    },
    async getReport(artistId, settlementMonth) {
      requireArtist(actor, artistId);
      const latest = await db.artistMonthlyReport.findFirst({
        where: { artistId, settlementMonth, tasks: { some: { status: 'SUCCEEDED' } } },
        orderBy: [{ version: 'desc' }, { id: 'desc' }],
        select: { reportJson: true },
      });
      return latest ? MonthlyReportDocumentSchema.parse(latest.reportJson) : null;
    },
    async searchDocuments(query, options) {
      if (!permissionTags.length)
        throw new ReportError(403, 'FORBIDDEN', '当前服务未提供知识库访问上下文。');
      return documentsService.search(
        { query, limit: contextPolicy().topK },
        { permissionTags, ...options },
      );
    },
  };
}
