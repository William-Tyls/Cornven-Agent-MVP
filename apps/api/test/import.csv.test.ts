import { describe, expect, it } from 'vitest';

import { csvToRawPosRecords } from '../src/modules/import/import.csv.js';
import { normalizeRawPosRecords } from '../src/modules/import/import.service.js';
import { CsvRowsValidationError } from '../src/shared/errors.js';

const validCsv = `recordType,sourceRecordId,sourceTransactionId,parentTransactionId,artistId,artistName,venueId,venueName,productId,sku,productName,occurredAt,quantity,unitPrice,totalAmount,commissionAmount,tenantAmount,rentalId,rentalCommissionRate,cubeId,cubeCommissionRate,currency
sale,SRC-SALE-CSV-001,TX-SALE-CSV-001,,ART-001,Sample Artist,VENUE-001,Cornven Sample Venue,PROD-001,SKU-A-001,Sample Ceramic Cup,2026-08-20T04:00:00.000Z,2,50.00,100.00,85.00,15.00,RENTAL-001,0.85,CUBE-001,0.25,TWD
refund,SRC-REFUND-CSV-001,TX-REFUND-CSV-001,TX-SALE-CSV-001,ART-001,Sample Artist,VENUE-001,Cornven Sample Venue,PROD-001,SKU-A-001,Sample Ceramic Cup,2026-10-03T04:00:00.000Z,-1,50.00,-50.00,-42.50,-7.50,RENTAL-001,0.85,CUBE-001,0.25,TWD`;

function getCsvValidationError(csv: string): CsvRowsValidationError {
  try {
    csvToRawPosRecords(csv);
  } catch (error) {
    if (error instanceof CsvRowsValidationError) {
      return error;
    }

    throw error;
  }

  throw new Error('Expected CSV validation to fail.');
}

describe('csvToRawPosRecords', () => {
  it('converts temporary POS CSV rows into raw SALE and REFUND records', () => {
    expect(csvToRawPosRecords(validCsv)).toEqual([
      expect.objectContaining({
        recordType: 'sale',
        sourceRecordId: 'SRC-SALE-CSV-001',
        quantity: 2,
        totalAmount: '100.00',
      }),
      expect.objectContaining({
        recordType: 'refund',
        sourceRecordId: 'SRC-REFUND-CSV-001',
        parentTransactionId: 'TX-SALE-CSV-001',
        quantity: -1,
        totalAmount: '-50.00',
      }),
    ]);
  });

  it('reports the CSV line and field when a REFUND has an invalid amount direction', () => {
    const csv = validCsv.replace(',-50.00,-42.50', ',50.00,-42.50');
    const error = getCsvValidationError(csv);

    expect(error.details).toEqual([
      expect.objectContaining({
        lineNumber: 3,
        field: 'totalAmount',
        reason:
          'CSV row 3: totalAmount — Refund total amount must be negative in the raw POS layer.',
      }),
    ]);
  });

  it('reports the CSV line and field when a REFUND has no parent transaction ID', () => {
    const csv = validCsv.replace(
      'TX-REFUND-CSV-001,TX-SALE-CSV-001,ART-001',
      'TX-REFUND-CSV-001,,ART-001',
    );
    const error = getCsvValidationError(csv);

    expect(error.details).toEqual([
      expect.objectContaining({
        lineNumber: 3,
        field: 'parentTransactionId',
      }),
    ]);
  });

  it('passes parsed CSV records into normalisation as independent SALE and REFUND records', () => {
    const rawRecords = csvToRawPosRecords(validCsv);
    const result = normalizeRawPosRecords(rawRecords, 'fraction');

    expect(result.summary).toMatchObject({
      totalRows: 2,
      saleRows: 1,
      refundRows: 1,
      canonicalSales: 2,
    });

    expect(result.records).toEqual([
      expect.objectContaining({
        recordType: 'sale',
        sourceTransactionId: 'TX-SALE-CSV-001',
        grossSalesCents: 10_000,
      }),
      expect.objectContaining({
        recordType: 'refund',
        sourceTransactionId: 'TX-REFUND-CSV-001',
        parentTransactionId: 'TX-SALE-CSV-001',
        grossSalesCents: -5_000,
      }),
    ]);
  });

  it('reports duplicate source record IDs from CSV', () => {
    const duplicateSale = `sale,SRC-SALE-CSV-001,TX-SALE-CSV-002,,ART-001,Sample Artist,VENUE-001,Cornven Sample Venue,PROD-002,SKU-A-002,Second Ceramic Cup,2026-08-21T04:00:00.000Z,1,50.00,50.00,42.50,7.50,RENTAL-001,0.85,CUBE-001,0.25,TWD`;
    const error = getCsvValidationError(`${validCsv}\n${duplicateSale}`);

    expect(error.details).toEqual([
      expect.objectContaining({
        lineNumber: 4,
        field: 'sourceRecordId',
        reason: 'CSV row 4: sourceRecordId — Duplicate source record ID: SRC-SALE-CSV-001.',
      }),
    ]);
  });
});
