import { readFileSync } from 'node:fs';

import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { RawPosImportRequestSchema, type SettlementPreviewInput } from '@cornven/contracts';

import { createApp } from '../src/app.js';
import { normalizeRawPosRecords } from '../src/modules/import/import.service.js';

const mockImport = RawPosImportRequestSchema.parse(
  JSON.parse(
    readFileSync(new URL('../../../fixtures/pos/mock-sales.json', import.meta.url), 'utf8'),
  ),
);

const goldenCase = JSON.parse(
  readFileSync(new URL('../../../fixtures/settlement/golden-case.json', import.meta.url), 'utf8'),
) as {
  input: Omit<SettlementPreviewInput, 'sales'>;
  expected: Record<string, unknown>;
};

const normalization = normalizeRawPosRecords(mockImport.records, mockImport.commissionRateUnit);
const csvImport = `recordType,sourceRecordId,sourceTransactionId,parentTransactionId,artistId,artistName,venueId,venueName,productId,sku,productName,occurredAt,quantity,unitPrice,totalAmount,commissionAmount,tenantAmount,rentalId,rentalCommissionRate,cubeId,cubeCommissionRate,currency
sale,SRC-SALE-API-001,TX-SALE-API-001,,ART-001,Sample Artist,VENUE-001,Cornven Sample Venue,PROD-001,SKU-A-001,Sample Ceramic Cup,2026-08-20T04:00:00.000Z,2,50.00,100.00,85.00,15.00,RENTAL-001,0.85,CUBE-001,0.25,TWD
refund,SRC-REFUND-API-001,TX-REFUND-API-001,TX-SALE-API-001,ART-001,Sample Artist,VENUE-001,Cornven Sample Venue,PROD-001,SKU-A-001,Sample Ceramic Cup,2026-10-03T04:00:00.000Z,-1,50.00,-50.00,-42.50,-7.50,RENTAL-001,0.85,CUBE-001,0.25,TWD`;

describe('Cornven API skeleton', () => {
  const app = createApp();

  it('returns a healthy status', async () => {
    const response = await request(app).get('/api/v1/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: 'ok',
      service: 'cornven-api',
      version: '0.1.0',
    });
  });

  it('normalizes independent SALE and REFUND records and keeps EXCHANGE audit-only', async () => {
    const response = await request(app).post('/api/v1/imports/mock/normalize').send(mockImport);

    expect(response.status).toBe(200);

    expect(response.body.summary).toEqual({
      totalRows: 3,
      saleRows: 1,
      refundRows: 1,
      exchangeRows: 1,
      canonicalSales: 2,
    });

    expect(response.body.records).toHaveLength(2);
    expect(response.body.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recordType: 'sale',
          sourceTransactionId: 'TX-001',
          parentTransactionId: null,
          quantitySold: 4,
          grossSalesCents: 20_000,
          sourceCommissionAmountCents: 5_000,
          sourceTenantAmountCents: 15_000,
          rentalCommissionBps: 2_000,
          cubeCommissionBps: 2_500,
        }),
        expect.objectContaining({
          recordType: 'refund',
          sourceTransactionId: 'TX-REFUND-001',
          parentTransactionId: 'TX-001',
          quantitySold: -1,
          grossSalesCents: -5_000,
          sourceCommissionAmountCents: -1_250,
          sourceTenantAmountCents: -3_750,
        }),
      ]),
    );

    expect(response.body.auditEvents).toEqual([
      expect.objectContaining({
        eventType: 'exchange',
        sourceRecordId: 'SRC-EXCHANGE-001',
      }),
    ]);
  });

  it('normalizes CSV text into independent SALE and REFUND records', async () => {
    const response = await request(app).post('/api/v1/imports/csv/normalize').send({
      commissionRateUnit: 'fraction',
      csv: csvImport,
    });

    expect(response.status).toBe(200);
    expect(response.body.summary).toEqual({
      totalRows: 2,
      saleRows: 1,
      refundRows: 1,
      exchangeRows: 0,
      canonicalSales: 2,
    });

    expect(response.body.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recordType: 'sale',
          sourceTransactionId: 'TX-SALE-API-001',
          parentTransactionId: null,
          grossSalesCents: 10_000,
        }),
        expect.objectContaining({
          recordType: 'refund',
          sourceTransactionId: 'TX-REFUND-API-001',
          parentTransactionId: 'TX-SALE-API-001',
          grossSalesCents: -5_000,
        }),
      ]),
    );
  });

  it('returns a row and field error when CSV data is invalid', async () => {
    const invalidCsv = csvImport.replace(',-50.00,-42.50', ',50.00,-42.50');

    const response = await request(app).post('/api/v1/imports/csv/normalize').send({
      commissionRateUnit: 'fraction',
      csv: invalidCsv,
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
    expect(response.body.error.details).toEqual([
      expect.objectContaining({
        field: 'totalAmount',
        code: 'CSV_ROW_INVALID',
        reason:
          'CSV row 3: totalAmount — Refund total amount must be negative in the raw POS layer.',
      }),
    ]);
  });

  it('returns all invalid CSV rows in one response', async () => {
    const refundWithPositiveAmount = csvImport.replace(',-50.00,-42.50', ',50.00,-42.50');

    const refundWithoutParent = `refund,SRC-REFUND-API-002,TX-REFUND-API-002,,ART-001,Sample Artist,VENUE-001,Cornven Sample Venue,PROD-002,SKU-A-002,Second Ceramic Cup,2026-10-04T04:00:00.000Z,-1,50.00,-50.00,-42.50,-7.50,RENTAL-001,0.85,CUBE-001,0.25,TWD`;

    const response = await request(app)
      .post('/api/v1/imports/csv/normalize')
      .send({
        commissionRateUnit: 'fraction',
        csv: `${refundWithPositiveAmount}\n${refundWithoutParent}`,
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
    expect(response.body.error.message).toBe('The CSV file contains invalid rows.');
    expect(response.body.error.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          lineNumber: 3,
          field: 'totalAmount',
          code: 'CSV_ROW_INVALID',
        }),
        expect.objectContaining({
          lineNumber: 4,
          field: 'parentTransactionId',
          code: 'CSV_ROW_INVALID',
        }),
      ]),
    );
  });

  it('does not match REFUND records against original sales in M2 normalization', async () => {
    const records = mockImport.records.map((record) =>
      record.recordType === 'refund' ? { ...record, quantity: -5 } : record,
    );

    const response = await request(app)
      .post('/api/v1/imports/mock/normalize')
      .send({ ...mockImport, records });

    expect(response.status).toBe(200);
    expect(response.body.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recordType: 'refund',
          parentTransactionId: 'TX-001',
          quantitySold: -5,
        }),
      ]),
    );
  });

  it('serves the single shared Agent Tool Registry', async () => {
    const response = await request(app).get('/api/v1/assistant/tools');

    expect(response.status).toBe(200);
    expect(response.body.tools).toHaveLength(7);
    expect(
      response.body.tools.every(
        (tool: { readOnly: boolean; input?: unknown; output?: unknown }) =>
          tool.readOnly && tool.input && tool.output,
      ),
    ).toBe(true);
  });

  it('calculates the artist monthly report using snapshotted Rental rates', async () => {
    const response = await request(app)
      .post('/api/v1/settlements/preview')
      .send({
        ...goldenCase.input,
        sales: normalization.records,
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject(goldenCase.expected);
    expect(response.body.creatorRevenueShareAmountCents).toBe(12000);
    expect(response.body.bankTransferFeeCents).toBeNull();
    expect(response.body.notes).toContain(
      'Bank transfer fee is unconfirmed; amount payable is unavailable.',
    );
  });

  it('matches the versioned golden settlement fixture', async () => {
    const response = await request(app)
      .post('/api/v1/settlements/preview')
      .send({
        ...goldenCase.input,
        sales: normalization.records,
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject(goldenCase.expected);
  });

  it('rejects a negative quantity in a Canonical SALE record', async () => {
    const response = await request(app)
      .post('/api/v1/settlements/preview')
      .send({
        ...goldenCase.input,
        sales: [{ ...normalization.records[0], quantitySold: -1 }],
      });

    expect(response.status).toBe(400);
    expect(response.body.error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'sales.0.quantitySold' })]),
    );
  });

  it('returns a stable error envelope for invalid input', async () => {
    const response = await request(app).post('/api/v1/settlements/preview').send({});

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
    expect(response.body.error.requestId).toEqual(expect.any(String));
  });
});
