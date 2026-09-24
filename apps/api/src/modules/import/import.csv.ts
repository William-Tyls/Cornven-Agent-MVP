import { parse } from 'csv-parse/sync';

import { RawPosRecordSchema, type RawPosRecord } from '@cornven/contracts';

import {
  CsvRowsValidationError,
  RequestValidationError,
  type CsvRowValidationDetail,
} from '../../shared/errors.js';

type CsvRow = Record<string, string>;

function optionalValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function requiredValue(row: CsvRow, field: string, lineNumber: number): string {
  const value = optionalValue(row[field]);

  if (!value) {
    throw new RequestValidationError(`CSV row ${lineNumber}: ${field} is required.`, field);
  }

  return value;
}

function integerValue(row: CsvRow, field: string, lineNumber: number): number {
  const rawValue = requiredValue(row, field, lineNumber);
  const value = Number(rawValue);

  if (!Number.isInteger(value)) {
    throw new RequestValidationError(`CSV row ${lineNumber}: ${field} must be an integer.`, field);
  }

  return value;
}

function validationErrorMessage(
  lineNumber: number,
  issues: { path: (string | number)[]; message: string }[],
): RequestValidationError {
  const firstIssue = issues[0];
  const field = firstIssue?.path.join('.') || 'record';
  const message = firstIssue?.message || 'Invalid input';

  return new RequestValidationError(`CSV row ${lineNumber}: ${field} — ${message}`, field);
}

function csvRowToRawPosRecord(row: CsvRow, lineNumber: number): RawPosRecord {
  const recordType = requiredValue(row, 'recordType', lineNumber);

  if (!['sale', 'refund', 'exchange'].includes(recordType)) {
    throw new RequestValidationError(
      `CSV row ${lineNumber}: recordType — recordType must be sale, refund, or exchange.`,
      'recordType',
    );
  }

  if (recordType === 'refund' && !optionalValue(row.parentTransactionId)) {
    throw new RequestValidationError(
      `CSV row ${lineNumber}: parentTransactionId — parentTransactionId is required for REFUND records.`,
      'parentTransactionId',
    );
  }

  const baseRecord = {
    recordType,
    sourceRecordId: requiredValue(row, 'sourceRecordId', lineNumber),
    sourceTransactionId: requiredValue(row, 'sourceTransactionId', lineNumber),
    parentTransactionId: optionalValue(row.parentTransactionId),
    artistId: requiredValue(row, 'artistId', lineNumber),
    artistName: requiredValue(row, 'artistName', lineNumber),
    venueId: requiredValue(row, 'venueId', lineNumber),
    venueName: requiredValue(row, 'venueName', lineNumber),
    productId: requiredValue(row, 'productId', lineNumber),
    ...(optionalValue(row.sku) ? { sku: optionalValue(row.sku) } : {}),
    productName: requiredValue(row, 'productName', lineNumber),
    occurredAt: requiredValue(row, 'occurredAt', lineNumber),
    quantity: integerValue(row, 'quantity', lineNumber),
    ...(optionalValue(row.currency) ? { currency: optionalValue(row.currency) } : {}),
  };

  const record =
    recordType === 'exchange'
      ? baseRecord
      : {
          ...baseRecord,
          unitPrice: requiredValue(row, 'unitPrice', lineNumber),
          totalAmount: requiredValue(row, 'totalAmount', lineNumber),
          commissionAmount: requiredValue(row, 'commissionAmount', lineNumber),
          tenantAmount: requiredValue(row, 'tenantAmount', lineNumber),
          rentalId: requiredValue(row, 'rentalId', lineNumber),
          rentalCommissionRate: requiredValue(row, 'rentalCommissionRate', lineNumber),
          ...(optionalValue(row.cubeId) ? { cubeId: optionalValue(row.cubeId) } : {}),
          ...(optionalValue(row.cubeCommissionRate)
            ? { cubeCommissionRate: optionalValue(row.cubeCommissionRate) }
            : {}),
        };

  const parsed = RawPosRecordSchema.safeParse(record);

  if (!parsed.success) {
    throw validationErrorMessage(lineNumber, parsed.error.issues);
  }

  return parsed.data;
}

export interface InspectedCsvRow {
  lineNumber: number;
  columns: CsvRow;
  record?: RawPosRecord;
}

export function inspectCsvRows(csvText: string): {
  rows: InspectedCsvRow[];
  errors: CsvRowValidationDetail[];
} {
  if (!csvText.trim()) {
    throw new RequestValidationError('CSV file is empty.', 'file');
  }

  let rows: CsvRow[];

  try {
    rows = parse(csvText, {
      bom: true,
      columns: (headers: string[]) => {
        if (new Set(headers).size !== headers.length || headers.some((header) => !header))
          throw new Error('CSV headers must be non-empty and unique.');
        return headers;
      },
      skip_empty_lines: true,
      trim: true,
    }) as CsvRow[];
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid CSV format.';
    throw new RequestValidationError(`Unable to parse CSV: ${message}`, 'file');
  }

  if (rows.length === 0) {
    throw new RequestValidationError('CSV file has no data rows.', 'file');
  }

  const inspected: InspectedCsvRow[] = [];
  const errors: CsvRowValidationDetail[] = [];
  const sourceRecordIds = new Set<string>();

  for (const [index, row] of rows.entries()) {
    const lineNumber = index + 2;
    const item: InspectedCsvRow = { lineNumber, columns: row };
    inspected.push(item);

    try {
      const record = csvRowToRawPosRecord(row, lineNumber);

      if (sourceRecordIds.has(record.sourceRecordId)) {
        errors.push({
          lineNumber,
          field: 'sourceRecordId',
          code: 'DUPLICATE_SOURCE_RECORD_ID',
          reason: `CSV row ${lineNumber}: sourceRecordId — Duplicate source record ID: ${record.sourceRecordId}.`,
        });
        continue;
      }

      sourceRecordIds.add(record.sourceRecordId);
      item.record = record;
    } catch (error) {
      if (error instanceof RequestValidationError) {
        errors.push({
          lineNumber,
          field: error.field,
          code: 'CSV_ROW_INVALID',
          reason: error.message,
        });
        continue;
      }

      throw error;
    }
  }

  return { rows: inspected, errors };
}

export function csvToRawPosRecords(csvText: string): RawPosRecord[] {
  const inspected = inspectCsvRows(csvText);
  if (inspected.errors.length > 0) throw new CsvRowsValidationError(inspected.errors);
  return inspected.rows.map((row) => row.record!);
}
