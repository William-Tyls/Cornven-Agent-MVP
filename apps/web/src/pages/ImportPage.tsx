import { useRef, useState } from 'react';
import { Link } from 'react-router';
import type { CommissionRateUnit, CsvBatch } from '@cornven/contracts';
import { confirmCsvBatch, uploadCsvBatch } from '../api/imports';
import { ImportBatchDetail } from '../components/ImportBatchDetail';
import { ErrorState, LoadingState } from '../components/StateViews';
import { selectCsvForPreview, type CsvPreview } from '../utils/csvPreview';

export function ImportPage() {
  const picker = useRef<HTMLInputElement>(null);
  const selecting = useRef(0);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [rateUnit, setRateUnit] = useState<CommissionRateUnit>('fraction');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [batch, setBatch] = useState<CsvBatch | null>(null);
  async function selectFile(selected: File | undefined) {
    if (!selected) return;
    const version = ++selecting.current;
    setBusy(true);
    setError(null);
    setBatch(null);
    setFile(null);
    setPreview(null);
    try {
      if (selected.size > 512_000) throw new Error('CSV files are limited to 500 KB.');
      const result = await selectCsvForPreview(selected);
      if (version !== selecting.current) return;
      if (!result.ok) throw new Error(result.message);
      setFile(selected);
      setPreview(result.preview);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not read CSV.');
    } finally {
      if (version === selecting.current) setBusy(false);
    }
  }
  async function upload() {
    if (!file) return;
    setBusy(true);
    setError(null);
    setBatch(null);
    try {
      setBatch(
        await uploadCsvBatch({
          csv: await file.text(),
          fileName: file.name,
          commissionRateUnit: rateUnit,
        }),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Validation failed.');
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    if (!batch) return;
    setBusy(true);
    setError(null);
    try {
      setBatch(await confirmCsvBatch(batch.id));
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Import failed. Retry the same batch to check its status.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="page-wrap">
      <header className="page-head">
        <p className="page-head__eyebrow">POS import</p>
        <h1>Import a CSV file</h1>
        <p>
          Check the file, review its records, then confirm import. A batch with errors adds no
          transactions.
        </p>
      </header>
      <section className="panel">
        <h2 className="panel__title">1. Choose and validate</h2>
        <p>
          <a href="/pos-import-template.csv" download>
            CSV template
          </a>{' '}
          ·{' '}
          <a href="/plan-b-import-demo.csv" download>
            September 2026 demo CSV
          </a>{' '}
          · <Link to="/import/errors">Import history</Link>
        </p>
        <p className="hint">
          Use existing artist, venue and rental references. Products are matched by external
          reference or the artist’s SKU. Up to 1,000 rows / 500 KB; new master records are not
          created automatically.
        </p>
        <input
          ref={picker}
          type="file"
          hidden
          accept=".csv,text/csv"
          disabled={busy}
          onChange={(event) => {
            const selected = event.target.files?.[0];
            event.target.value = '';
            void selectFile(selected);
          }}
        />
        <div className="actions-row">
          <button disabled={busy} type="button" onClick={() => picker.current?.click()}>
            Choose CSV file
          </button>
          {file && (
            <button
              type="button"
              className="button--secondary"
              disabled={busy}
              onClick={() => {
                setFile(null);
                setPreview(null);
                setBatch(null);
                setError(null);
              }}
            >
              Remove file
            </button>
          )}
        </div>
        {file && preview && (
          <>
            <p>
              Selected: <strong>{file.name}</strong> ({Math.ceil(file.size / 1024)} KB)
            </p>
            <details>
              <summary>Preview first {preview.rows.length} rows</summary>
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      {preview.headers.map((header, i) => (
                        <th key={i}>{header}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((row, i) => (
                      <tr key={i}>
                        {preview.headers.map((_, j) => (
                          <td key={j}>{row[j] ?? ''}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
            <label className="import-rate">
              Commission rate format
              <select
                value={rateUnit}
                disabled={busy}
                onChange={(event) => {
                  setRateUnit(event.target.value as CommissionRateUnit);
                  setBatch(null);
                  setError(null);
                }}
              >
                <option value="fraction">Fraction (0.25 = 25%)</option>
                <option value="percentage">Percentage (25 = 25%)</option>
                <option value="basis_points">Basis points (2500 = 25%)</option>
              </select>
            </label>
            <button
              data-testid="validate-import"
              type="button"
              disabled={busy}
              onClick={() => void upload()}
            >
              Validate selected CSV
            </button>
          </>
        )}
      </section>
      {busy && <LoadingState label="Processing saved import batch…" />}
      {error && <ErrorState title={error} />}
      {batch && <ImportBatchDetail batch={batch} busy={busy} onConfirm={() => void confirm()} />}
    </div>
  );
}
