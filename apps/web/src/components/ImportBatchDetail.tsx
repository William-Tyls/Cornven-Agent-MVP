import { Link } from 'react-router';
import type { CsvBatch } from '@cornven/contracts';

export function ImportBatchDetail({
  batch,
  busy = false,
  onConfirm,
}: {
  batch: CsvBatch;
  busy?: boolean;
  onConfirm: () => void;
}) {
  return (
    <section className="panel" aria-label="Import batch detail" data-testid="import-batch-detail">
      <h2 className="panel__title">{batch.fileName}</h2>
      <p>
        <span
          className={
            'badge ' +
            (batch.status === 'IMPORTED'
              ? 'badge--success'
              : batch.status === 'FAILED'
                ? 'badge--danger'
                : 'badge--neutral')
          }
        >
          {batch.status}
        </span>
      </p>
      <p className="hint">
        Batch: {batch.id} · {new Date(batch.createdAt).toLocaleString()}
      </p>
      <div className="summary-pills">
        <span className="badge badge--neutral">Total rows: {batch.totalRows}</span>
        <span className="badge badge--neutral">Sales: {batch.summary.saleRows}</span>
        <span className="badge badge--neutral">Refunds: {batch.summary.refundRows}</span>
        <span className="badge badge--neutral">Exchanges: {batch.summary.exchangeRows}</span>
        <span className="badge badge--neutral">
          Transactions {batch.status === 'IMPORTED' ? 'added' : 'to add'}:{' '}
          {batch.summary.newRecords}
        </span>
        <span className="badge badge--neutral">
          Existing transactions: {batch.summary.duplicateRecords}
        </span>
      </div>
      {batch.status === 'VALIDATED' && (
        <>
          <p>
            Validation passed. No transactions have been added yet. Confirmation rechecks the saved
            file and imports the whole batch together.
          </p>
          <button type="button" data-testid="confirm-import" disabled={busy} onClick={onConfirm}>
            {busy ? 'Importing…' : 'Confirm import'}
          </button>
        </>
      )}
      {batch.status === 'IMPORTED' && (
        <>
          <p className="hint">
            Confirmed: {batch.confirmedAt ? new Date(batch.confirmedAt).toLocaleString() : '—'}.
            Re-uploading this batch does not add its transactions again.
          </p>
          <p role="status">
            Import complete. {batch.summary.newRecords} new transaction(s),{' '}
            {batch.summary.duplicateRecords} existing transaction(s) skipped;{' '}
            {batch.summary.newExchanges} new exchange audit record(s),{' '}
            {batch.summary.duplicateExchanges} existing exchange(s) skipped.
          </p>
          <p>
            Previously saved reports stay unchanged. Generate a new report to include these
            transactions within its reporting period.
          </p>
          <Link className="button" to="/settlements">
            Generate / view reports
          </Link>
        </>
      )}
      {batch.status === 'FAILED' && (
        <p role="alert">
          No transactions were added. Correct the listed problems and upload the file again.
        </p>
      )}
      {batch.issues.length > 0 && (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>CSV row</th>
                <th>Field</th>
                <th>Problem</th>
              </tr>
            </thead>
            <tbody>
              {batch.issues.map((issue, index) => (
                <tr key={index}>
                  <td>{issue.lineNumber ?? 'File'}</td>
                  <td>{issue.field}</td>
                  <td>{issue.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {batch.preview.length > 0 && (
        <details open>
          <summary>Mapped records (first {batch.preview.length})</summary>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Row</th>
                  <th>Type</th>
                  <th>Transaction</th>
                  <th>Artist / product</th>
                  <th>Amount (TWD)</th>
                  <th>Existing</th>
                </tr>
              </thead>
              <tbody>
                {batch.preview.map((row) => (
                  <tr key={row.lineNumber}>
                    <td>{row.lineNumber}</td>
                    <td>{row.recordType}</td>
                    <td>{row.sourceTransactionId}</td>
                    <td>
                      {row.artistName}
                      <br />
                      {row.productName}
                    </td>
                    <td>
                      {row.grossSalesCents === null
                        ? 'Audit only'
                        : (row.grossSalesCents / 100).toFixed(2)}
                    </td>
                    <td>{row.duplicate ? 'Yes — skipped' : 'No'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
      <p>
        <Link to={'/import/errors?batch=' + encodeURIComponent(batch.id)}>
          Open saved batch in import history
        </Link>
      </p>
    </section>
  );
}
