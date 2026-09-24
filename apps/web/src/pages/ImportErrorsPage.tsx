import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { CsvBatch, CsvBatchList } from '@cornven/contracts';
import { listCsvBatches, getCsvBatch, confirmCsvBatch } from '../api/imports';
import { ImportBatchDetail } from '../components/ImportBatchDetail';
import { EmptyState, ErrorState, LoadingState } from '../components/StateViews';

export function ImportErrorsPage() {
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('batch');
  const [filter, setFilter] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [listing, setListing] = useState<CsvBatchList>({ items: [], nextCursor: null });
  const [selected, setSelected] = useState<CsvBatch | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setSelected(null);
    setListing({ items: [], nextCursor: null });
    Promise.all([
      listCsvBatches(filter),
      selectedId ? getCsvBatch(selectedId) : Promise.resolve(null),
    ])
      .then(([list, batch]) => {
        if (active) {
          setListing(list);
          setSelected(batch);
        }
      })
      .catch((caught: unknown) => {
        if (active) setError(caught instanceof Error ? caught.message : 'Could not load imports.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [filter, refresh, selectedId]);
  async function more() {
    if (!listing.nextCursor) return;
    setLoading(true);
    setError(null);
    try {
      const page = await listCsvBatches(filter, listing.nextCursor);
      setListing((current) => ({
        items: [...current.items, ...page.items],
        nextCursor: page.nextCursor,
      }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load more imports.');
    } finally {
      setLoading(false);
    }
  }
  async function confirm() {
    if (!selected) return;
    setConfirming(true);
    setError(null);
    try {
      await confirmCsvBatch(selected.id);
      setRefresh((value) => value + 1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Import failed.');
    } finally {
      setConfirming(false);
    }
  }
  return (
    <div className="page-wrap">
      <header className="page-head">
        <h1>Import history</h1>
        <p>
          Saved validation results, confirmed imports and row-level errors.{' '}
          <Link to="/import">Upload another CSV</Link>
        </p>
      </header>
      <section className="panel">
        <div className="actions-row">
          <label>
            Status{' '}
            <select
              aria-label="Import status"
              value={filter}
              disabled={loading || confirming}
              onChange={(event) => setFilter(event.target.value)}
            >
              <option value="">All</option>
              <option value="VALIDATED">Awaiting confirmation</option>
              <option value="IMPORTED">Imported</option>
              <option value="FAILED">Failed validation</option>
            </select>
          </label>
          <button
            type="button"
            disabled={loading || confirming}
            onClick={() => setRefresh((value) => value + 1)}
          >
            Refresh
          </button>
        </div>
        {listing.items.length > 0 ? (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Created</th>
                  <th>Status</th>
                  <th>Rows / errors</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {listing.items.map((item) => (
                  <tr key={item.id}>
                    <td>{item.fileName}</td>
                    <td>{new Date(item.createdAt).toLocaleString()}</td>
                    <td>{item.status}</td>
                    <td>
                      {item.totalRows} / {item.invalidRows}
                    </td>
                    <td>
                      <button
                        type="button"
                        disabled={loading || confirming}
                        onClick={() => setParams({ batch: item.id })}
                      >
                        View batch
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          !loading && <EmptyState label="No import batches match this filter." />
        )}
        {listing.nextCursor && (
          <button type="button" disabled={loading || confirming} onClick={() => void more()}>
            Load more
          </button>
        )}
      </section>
      {loading && <LoadingState />}
      {error && <ErrorState title={error} />}
      {selected && (
        <ImportBatchDetail
          batch={selected}
          busy={confirming || loading}
          onConfirm={() => void confirm()}
        />
      )}
    </div>
  );
}
