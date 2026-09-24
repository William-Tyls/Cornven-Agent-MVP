import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { actOnApproval } from '../api/approvals';
import type {
  ArtistListResponse,
  MonthlyReportDocument,
  MonthlySettlementPreviewResponse,
  ReportSummary,
} from '@cornven/contracts';
import { ApiError } from '../api/client';
import {
  downloadReport,
  generateReport,
  getReport,
  listArtists,
  listReports,
} from '../api/reports';
import { EmptyState, ErrorState, LoadingState } from '../components/StateViews';
import { SettlementBreakdown } from '../components/SettlementBreakdown';
import { previewMonthlySettlement } from '../api/settlements';

const currentMonth = () => new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 7);

const taipeiTime = (value: string) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Taipei',
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(new Date(value));
const messageFor = (error: unknown) =>
  error instanceof ApiError
    ? `${error.code}: ${error.message}`
    : error instanceof Error
      ? error.message
      : 'Request failed.';

export function SettlementsPage() {
  const submissionKeys = useRef(new Map<string, string>());
  const [submittedId, setSubmittedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [artists, setArtists] = useState<ArtistListResponse['items']>([]);
  const [artistCursor, setArtistCursor] = useState<string | null>(null);
  const [artistId, setArtistId] = useState('');
  const [month, setMonth] = useState('');
  const [previewMonth, setPreviewMonth] = useState(currentMonth);
  const [preview, setPreview] = useState<MonthlySettlementPreviewResponse | null>(null);
  const [reports, setReports] = useState<ReportSummary[]>([]);
  const [reportCursor, setReportCursor] = useState<string | null>(null);
  const [document, setDocument] = useState<MonthlyReportDocument | null>(null);
  const [busy, setBusy] = useState(false);
  const [artistsLoading, setArtistsLoading] = useState(true);
  const [reportsLoading, setReportsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<{ artistId: string; key: string } | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    setArtistsLoading(true);
    setError(null);
    setPreview(null);
    setDocument(null);
    setNotice(null);
    setAttempt(null);
    void listArtists(query)
      .then((result) => {
        if (!active) return;
        setArtists(result.items);
        setArtistCursor(result.nextCursor);
        setArtistId(result.items[0]?.artistId ?? '');
        setDocument(null);
        setAttempt(null);
      })
      .catch((e) => {
        if (active) setError(messageFor(e));
      })
      .finally(() => {
        if (active) setArtistsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [query]);

  useEffect(() => {
    let active = true;
    setReports([]);
    setReportCursor(null);
    if (artistId) {
      setReportsLoading(true);
      void listReports(artistId, month)
        .then((result) => {
          if (active) {
            setReports(result.items);
            setReportCursor(result.nextCursor);
          }
        })
        .catch((e) => {
          if (active) setError(messageFor(e));
        })
        .finally(() => {
          if (active) setReportsLoading(false);
        });
    } else setReportsLoading(false);
    return () => {
      active = false;
    };
  }, [artistId, month, reload]);

  async function run(retry = false) {
    if (!artistId || previewMonth !== currentMonth()) return;
    const request =
      retry && attempt?.artistId === artistId ? attempt : { artistId, key: crypto.randomUUID() };
    setAttempt(request);
    setBusy(true);
    setError(null);
    setNotice(null);
    setPreview(null);
    setDocument(null);
    try {
      const result = await generateReport(request.artistId, request.key);
      const saved = await getReport(result.reportId);
      setDocument(saved);
      setNotice(`Report saved. Data cutoff: ${taipeiTime(result.asOf)} (Asia/Taipei).`);
      setAttempt(null);
      setReload((n) => n + 1);
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setBusy(false);
    }
  }

  async function view(id: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    setPreview(null);
    setDocument(null);
    try {
      setDocument(await getReport(id));
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setBusy(false);
    }
  }
  async function submit(id: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    setSubmittedId(null);
    const key = submissionKeys.current.get(id) ?? crypto.randomUUID();
    submissionKeys.current.set(id, key);
    try {
      const result = await actOnApproval(id, { action: 'submit', requestId: key, reason: '' });
      setNotice(`Version ${result.summary.version}: ${result.summary.approvalStatus}.`);
      setSubmittedId(id);
      setReload((n) => n + 1);
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setBusy(false);
    }
  }
  async function download(id: string) {
    setBusy(true);
    setError(null);
    try {
      await downloadReport(id);
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setBusy(false);
    }
  }
  async function moreArtists() {
    if (!artistCursor) return;
    setBusy(true);
    try {
      const page = await listArtists(query, artistCursor);
      setArtists((old) => [...old, ...page.items]);
      setArtistCursor(page.nextCursor);
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setBusy(false);
    }
  }
  async function moreReports() {
    if (!reportCursor) return;
    setBusy(true);
    try {
      const page = await listReports(artistId, month, reportCursor);
      setReports((old) => [...old, ...page.items]);
      setReportCursor(page.nextCursor);
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setBusy(false);
    }
  }

  async function calculate() {
    if (!artistId || !previewMonth) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    setPreview(null);
    setDocument(null);
    try {
      setPreview(await previewMonthlySettlement({ artistId, settlementMonth: previewMonth }));
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setBusy(false);
    }
  }

  const disabled = busy || artistsLoading;
  const canSave = previewMonth === currentMonth();

  return (
    <div className="page-wrap reports-page">
      <header className="page-head">
        <h1>Settlement Runs</h1>
        <p>
          Preview a settlement, generate and save a current-month report, or view saved versions.
          Submit a saved version for review and track its decision in Approvals.
        </p>
      </header>
      <section className="panel">
        <h2>Artist and settlement month</h2>
        <form
          className="actions-row"
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(search);
          }}
        >
          <label>
            Search artists
            <input value={search} onChange={(e) => setSearch(e.target.value)} disabled={disabled} />
          </label>
          <button disabled={disabled}>Search</button>
        </form>
        <div className="actions-row">
          <label>
            Artist
            <select
              aria-label="Settlement artist"
              value={artistId}
              disabled={disabled}
              onChange={(e) => {
                setArtistId(e.target.value);
                setDocument(null);
                setPreview(null);
                setAttempt(null);
                setNotice(null);
                setError(null);
              }}
            >
              {!artists.length && <option value="">No artists found</option>}
              {artists.map((a) => (
                <option key={a.artistId} value={a.artistId}>
                  {a.artistName}
                  {a.brandName ? ` — ${a.brandName}` : ''}
                </option>
              ))}
            </select>
          </label>
          <label>
            Settlement month
            <input
              aria-label="Settlement month"
              type="month"
              min="2000-01"
              max={currentMonth()}
              value={previewMonth}
              disabled={disabled}
              onChange={(e) => {
                setPreviewMonth(e.target.value);
                setPreview(null);
                setDocument(null);
                setNotice(null);
                setError(null);
              }}
            />
          </label>
          <button
            type="button"
            className="button--secondary"
            disabled={disabled}
            onClick={() => {
              setPreviewMonth(currentMonth());
              setPreview(null);
              setDocument(null);
              setNotice(null);
              setError(null);
            }}
          >
            Current month
          </button>
        </div>
        {artistCursor && (
          <button disabled={disabled} onClick={() => void moreArtists()}>
            Load more artists
          </button>
        )}
        <div className="actions-row">
          <button
            type="button"
            className="button--secondary"
            disabled={disabled || !artistId || !previewMonth || previewMonth > currentMonth()}
            data-testid="preview-settlement"
            onClick={() => void calculate()}
          >
            Read-only preview
          </button>
          <button
            disabled={disabled || !artistId || !canSave}
            data-testid="generate-report"
            onClick={() => void run()}
          >
            Generate &amp; save current-month report
          </button>
          {attempt && (
            <button disabled={disabled || !canSave} onClick={() => void run(true)}>
              Retry same request
            </button>
          )}
        </div>
        <p className="hint">
          Preview reads the selected month without saving. Generate &amp; save recalculates the
          current month through server time and saves a new report version and PDF. All dates use
          Asia/Taipei.
        </p>
        {!canSave && (
          <p className="hint">
            Historical months can be previewed. Select Current month to generate and save a report.
          </p>
        )}
      </section>
      {error && <ErrorState title={error} />}
      {notice && <p role="status">{notice}</p>}
      {submittedId && (
        <p>
          <Link to={`/approvals?reportId=${encodeURIComponent(submittedId)}`}>
            Open submitted report in Approvals
          </Link>
        </p>
      )}
      {artistsLoading && <LoadingState label="Loading artists…" />}
      {busy && <LoadingState label="Working…" />}
      {preview && <PreviewDetail preview={preview} />}
      {document && (
        <ReportDetail
          report={document}
          onDownload={() => void download(document.reportId)}
          busy={busy}
        />
      )}
      <section className="panel">
        <h2>Saved reports</h2>
        <div className="actions-row">
          <label>
            Filter report month
            <input
              type="month"
              value={month}
              disabled={disabled || reportsLoading}
              onChange={(e) => setMonth(e.target.value)}
            />
          </label>
          <button disabled={disabled || reportsLoading} onClick={() => setMonth('')}>
            All months
          </button>
          <button
            disabled={disabled || reportsLoading}
            data-testid="refresh-reports"
            onClick={() => setReload((n) => n + 1)}
          >
            Refresh reports
          </button>
        </div>
        {reportsLoading && <LoadingState label="Loading saved reports…" />}
        {!artistsLoading && !reportsLoading && reports.length === 0 && (
          <EmptyState label="No saved reports for this selection." />
        )}
        {reports.length > 0 && (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Month</th>
                  <th>Version</th>
                  <th>Source</th>
                  <th>Review status</th>
                  <th>Cutoff (Taipei)</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {reports.map((r) => (
                  <tr key={r.reportId}>
                    <td>
                      {r.settlementMonth}
                      {r.isProvisional ? ' · Month to date' : ' · Complete month'}
                    </td>
                    <td>{r.version}</td>
                    <td>{r.trigger === 'scheduled' ? 'Automatic' : 'Manual'}</td>
                    <td>{r.approvalStatus ?? 'draft'}</td>
                    <td>{taipeiTime(r.asOf)}</td>
                    <td>
                      <button
                        data-testid={`view-report-${r.reportId}`}
                        disabled={disabled || reportsLoading}
                        onClick={() => void view(r.reportId)}
                      >
                        View
                      </button>{' '}
                      <button
                        disabled={disabled || reportsLoading}
                        onClick={() => void download(r.reportId)}
                      >
                        Download PDF
                      </button>{' '}
                      <button
                        disabled={
                          disabled ||
                          reportsLoading ||
                          (r.approvalStatus !== undefined && r.approvalStatus !== 'draft')
                        }
                        data-testid={`submit-report-${r.reportId}`}
                        onClick={() => void submit(r.reportId)}
                      >
                        Submit for review
                      </button>{' '}
                      <Link to={`/approvals?reportId=${encodeURIComponent(r.reportId)}`}>
                        Review status
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {reportCursor && (
          <button disabled={disabled || reportsLoading} onClick={() => void moreReports()}>
            Load more reports
          </button>
        )}
      </section>
    </div>
  );
}

function PreviewDetail({ preview }: { preview: MonthlySettlementPreviewResponse }) {
  return (
    <section className="panel" aria-label="Settlement preview result">
      <h2>
        {preview.result.creator.brandName ?? preview.result.creator.artistName ?? 'Artist'} —{' '}
        {preview.settlementMonth}
      </h2>
      <p role="status">
        Read-only preview · {preview.result.isProvisional ? 'Month to date' : 'Complete month'} ·
        Not saved
      </p>
      <p>
        {preview.result.settlementPeriod.from} to {preview.result.settlementPeriod.to}
      </p>
      <p>Data cutoff: {taipeiTime(preview.dataCutoff)} (Asia/Taipei)</p>
      <p className="hint">
        Calculated: {taipeiTime(preview.calculatedAt)} (Asia/Taipei). Recalculate after importing
        new transactions.
      </p>
      <SettlementBreakdown result={preview.result} />
    </section>
  );
}

export function ReportDetail({
  report: r,
  onDownload,
  busy,
}: {
  report: MonthlyReportDocument;
  onDownload: () => void;
  busy: boolean;
}) {
  return (
    <section className="panel" aria-label="Report detail">
      <h2>
        {r.creator.displayName} — {r.settlementMonth}
      </h2>
      <p>
        Saved report · {r.isProvisional ? 'Month-to-date draft' : 'Complete-month draft'} ·{' '}
        {r.settlementPeriod.from} to {r.settlementPeriod.to}
      </p>
      <p>Data cutoff: {taipeiTime(r.settlementPeriod.asOf)} (Asia/Taipei)</p>
      <button disabled={busy} data-testid="download-report" onClick={onDownload}>
        Download this PDF
      </button>
      <SettlementBreakdown
        result={{
          ...r.financialSummary,
          currency: r.currency,
          rentals: r.rentals,
          monthlyProductSalesDetails: r.monthlyProductSalesDetails,
          lowStockReminder: r.lowStockReminder,
          notes: r.notes,
        }}
      />
    </section>
  );
}
