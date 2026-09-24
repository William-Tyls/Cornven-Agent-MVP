import Papa from 'papaparse';

export interface CsvPreview {
  headers: string[];
  rows: string[][];
}

export type CsvPreviewResult = { ok: true; preview: CsvPreview } | { ok: false; message: string };

export function validateCsvFile(file: File): string | null {
  if (!file.name.toLowerCase().endsWith('.csv')) {
    return 'Only CSV files are supported.';
  }

  if (file.size === 0) {
    return 'The CSV file is empty.';
  }

  return null;
}

export async function parseCsvPreview(file: File): Promise<CsvPreviewResult> {
  try {
    const { data, errors } = Papa.parse<string[]>(await file.text(), {
      skipEmptyLines: 'greedy',
    });

    if (errors.length > 0) {
      return {
        ok: false,
        message: `CSV could not be read: ${errors[0]?.message ?? 'unknown error'}`,
      };
    }

    const [headers, ...rows] = data;
    if (!headers || headers.length === 0) {
      return { ok: false, message: 'The CSV file needs a header row.' };
    }

    return { ok: true, preview: { headers, rows: rows.slice(0, 5) } };
  } catch {
    return { ok: false, message: 'CSV could not be read.' };
  }
}

export async function selectCsvForPreview(file: File): Promise<CsvPreviewResult> {
  const validationMessage = validateCsvFile(file);
  return validationMessage ? { ok: false, message: validationMessage } : parseCsvPreview(file);
}
