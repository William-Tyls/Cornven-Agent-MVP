import { describe, expect, it } from 'vitest';

import { parseCsvPreview, selectCsvForPreview, validateCsvFile } from './csvPreview';

describe('validateCsvFile', () => {
  it('accepts a non-empty CSV file regardless of extension case', () => {
    expect(validateCsvFile(new File(['name,amount\nCup,10'], 'sales.CSV'))).toBeNull();
  });

  it('rejects a non-CSV file and an empty CSV file', () => {
    expect(validateCsvFile(new File(['x'], 'sales.xlsx'))).toBe('Only CSV files are supported.');
    expect(validateCsvFile(new File([], 'sales.csv'))).toBe('The CSV file is empty.');
  });
});

describe('parseCsvPreview', () => {
  it('returns headers and at most five rows while preserving quoted commas', async () => {
    const result = await parseCsvPreview(
      new File(['product,artist\n"Cup, large","Ava Lee"\nPrint,Sam'], 'sales.csv'),
    );

    expect(result).toEqual({
      ok: true,
      preview: {
        headers: ['product', 'artist'],
        rows: [
          ['Cup, large', 'Ava Lee'],
          ['Print', 'Sam'],
        ],
      },
    });
  });

  it('returns a readable error when CSV parsing finds malformed quoted data', async () => {
    const result = await parseCsvPreview(new File(['product\n"unterminated'], 'broken.csv'));

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        message: expect.stringContaining('CSV could not be read:'),
      }),
    );
  });
});

describe('selectCsvForPreview', () => {
  it('does not parse an invalid file', async () => {
    await expect(selectCsvForPreview(new File(['x'], 'sales.xlsx'))).resolves.toEqual({
      ok: false,
      message: 'Only CSV files are supported.',
    });
  });
});
