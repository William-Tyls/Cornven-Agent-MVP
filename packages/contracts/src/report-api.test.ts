import { describe, expect, it } from 'vitest';

import {
  GenerateMonthlyReportRequestSchema,
  GenerateMonthlyReportResponseSchema,
} from './report-api.js';

const validRequest = {
  artistId: 'ART-001',
  period: 'current_month',
  format: 'pdf',
} as const;

const validResponse = {
  reportId: 'REPORT-001',
  artistId: 'ART-001',
  displayName: 'Sample Artist',
  settlementMonth: '2026-08',
  asOf: '2026-08-18T00:00:00.000Z',
  generatedAt: '2026-08-18T00:00:01.000Z',
  isProvisional: true,
  reportStatus: 'draft',
  generationStatus: 'ready',
  pdfFileReference: '/api/v1/reports/REPORT-001/download',
} as const;

describe('GenerateMonthlyReportRequestSchema', () => {
  it('accepts the synchronous PDF report request', () => {
    expect(GenerateMonthlyReportRequestSchema.parse(validRequest)).toEqual(validRequest);
  });

  it.each([
    ['display month', { ...validRequest, settlementMonth: '08/2026' }],
    ['invalid calendar month', { ...validRequest, settlementMonth: '2026-13' }],
    ['non-PDF format', { ...validRequest, format: 'csv' }],
  ])('rejects a %s', (_label, request) => {
    expect(GenerateMonthlyReportRequestSchema.safeParse(request).success).toBe(false);
  });

  it.each([
    ['artist name', { ...validRequest, artistName: 'Sample Artist' }],
    ['period start', { ...validRequest, periodStart: '2026-08-01' }],
    ['period end', { ...validRequest, periodEnd: '2026-08-31' }],
    ['rental ID', { ...validRequest, rentalId: 'RENTAL-001' }],
    ['settlement run ID', { ...validRequest, settlementRunId: 'RUN-001' }],
  ])('rejects the extra %s lookup field', (_label, request) => {
    expect(GenerateMonthlyReportRequestSchema.safeParse(request).success).toBe(false);
  });
});

describe('GenerateMonthlyReportResponseSchema', () => {
  it('accepts the ready synchronous PDF report response', () => {
    expect(GenerateMonthlyReportResponseSchema.parse(validResponse)).toEqual(validResponse);
  });

  it('rejects a settlement run ID owned by the settlement boundary', () => {
    expect(
      GenerateMonthlyReportResponseSchema.safeParse({
        ...validResponse,
        settlementRunId: 'RUN-001',
      }).success,
    ).toBe(false);
  });

  it.each([
    ['non-draft report status', { ...validResponse, reportStatus: 'final' }],
    ['non-ready generation status', { ...validResponse, generationStatus: 'pending' }],
    ['empty download reference', { ...validResponse, pdfFileReference: '   ' }],
  ])('rejects a %s', (_label, response) => {
    expect(GenerateMonthlyReportResponseSchema.safeParse(response).success).toBe(false);
  });
});
