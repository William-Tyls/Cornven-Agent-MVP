import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { ApprovalCommand, ApprovalDetail, ApprovalSummary } from '@cornven/contracts';
import { actOnApproval, getApproval, listApprovals } from '../api/approvals';
import { downloadReport } from '../api/reports';
import { EmptyState, ErrorState, LoadingState } from '../components/StateViews';
import { ReportDetail } from './SettlementsPage';
const label = {
  draft: 'Draft',
  pending: 'Pending review',
  approved: 'Approved',
  rejected: 'Rejected',
};
const time = (value: string) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Taipei',
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(new Date(value));
const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Request failed.');
export function ApprovalsPage() {
  const [params, setParams] = useSearchParams();
  const reportId = params.get('reportId');
  const [status, setStatus] = useState('pending');
  const [artistQuery, setArtistQuery] = useState('');
  const [month, setMonth] = useState('');
  const [query, setQuery] = useState('status=pending');
  const [items, setItems] = useState<ApprovalSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [detail, setDetail] = useState<ApprovalDetail | null>(null);
  const [reason, setReason] = useState('');
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const attempt = useRef<{ reportId: string; command: ApprovalCommand } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setItems([]);
    setCursor(null);
    void listApprovals(new URLSearchParams(query))
      .then((result) => {
        if (active) {
          setItems(result.items);
          setCursor(result.nextCursor);
        }
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [query, reload]);
  useEffect(() => {
    let active = true;
    setDetail(null);
    setReason('');
    setError(null);
    setNotice(null);
    if (!reportId) {
      setDetailLoading(false);
      return;
    }
    setDetailLoading(true);
    void getApproval(reportId)
      .then((value) => {
        if (active) setDetail(value);
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      })
      .finally(() => {
        if (active) setDetailLoading(false);
      });
    return () => {
      active = false;
    };
  }, [reportId]);
  async function act(action: ApprovalCommand['action']) {
    if (!detail || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    const id = detail.summary.reportId;
    const text = action === 'submit' ? '' : reason.trim();
    if (
      attempt.current?.reportId !== id ||
      attempt.current.command.action !== action ||
      attempt.current.command.reason !== text
    )
      attempt.current = {
        reportId: id,
        command: { action, reason: text, requestId: crypto.randomUUID() },
      };
    try {
      const result = await actOnApproval(id, attempt.current.command);
      setDetail(result);
      setReason('');
      attempt.current = null;
      setNotice(`Version ${result.summary.version}: ${label[result.summary.approvalStatus]}.`);
      setReload((n) => n + 1);
    } catch (e) {
      setError(errorText(e));
      // A competing reviewer or a lost response may already have changed the state.
      try {
        setDetail(await getApproval(id));
      } catch {
        /* Keep the actionable request error. */
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function refresh() {
    setError(null);
    setBusy(true);
    setReload((n) => n + 1);
    try {
      if (reportId) setDetail(await getApproval(reportId));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function more() {
    if (!cursor) return;
    setBusy(true);
    setError(null);
    try {
      const next = new URLSearchParams(query);
      next.set('cursor', cursor);
      const result = await listApprovals(next);
      setItems((old) => [...old, ...result.items]);
      setCursor(result.nextCursor);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function download() {
    if (!detail) return;
    setBusy(true);
    setError(null);
    try {
      await downloadReport(detail.summary.reportId);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="page-wrap reports-page approvals-page">
      <header className="page-head">
        <h1>Approvals</h1>
        <p>
          Review a saved report version and record your decision. Approval does not record a
          payment.
        </p>
        <p className="hint">Local demo identity · All times shown in Asia/Taipei.</p>
      </header>
      <section className="panel">
        <h2>Review queue</h2>
        <form
          className="actions-row"
          onSubmit={(e) => {
            e.preventDefault();
            const q = new URLSearchParams();
            if (status) q.set('status', status);
            if (artistQuery.trim()) q.set('artistQuery', artistQuery.trim());
            if (month) q.set('settlementMonth', month);
            setError(null);
            setQuery(q.toString());
            setReload((n) => n + 1);
          }}
        >
          <label>
            Status
            <select
              aria-label="Approval status"
              value={status}
              disabled={busy || loading}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="">All statuses</option>
              {Object.entries(label).map(([value, text]) => (
                <option key={value} value={value}>
                  {text}
                </option>
              ))}
            </select>
          </label>
          <label>
            Artist
            <input
              aria-label="Approval artist search"
              value={artistQuery}
              disabled={busy || loading}
              onChange={(e) => setArtistQuery(e.target.value)}
            />
          </label>
          <label>
            Month
            <input
              aria-label="Approval month"
              type="month"
              value={month}
              disabled={busy || loading}
              onChange={(e) => setMonth(e.target.value)}
            />
          </label>
          <button disabled={busy || loading}>Apply filters</button>
          <button
            type="button"
            disabled={busy || loading || detailLoading}
            onClick={() => void refresh()}
          >
            Refresh
          </button>
        </form>
        {loading && <LoadingState label="Loading approval queue…" />}
        {!loading && !items.length && <EmptyState label="No reports match these filters." />}
        {!!items.length && (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Artist</th>
                  <th>Month</th>
                  <th>Version</th>
                  <th>Status</th>
                  <th>Cutoff (Taipei)</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.reportId}>
                    <td>{item.displayName}</td>
                    <td>
                      {item.settlementMonth}
                      {item.isProvisional ? ' · Month to date' : ''}
                    </td>
                    <td>{item.version}</td>
                    <td>{label[item.approvalStatus]}</td>
                    <td>{time(item.asOf)}</td>
                    <td>
                      <button
                        disabled={busy}
                        data-testid={`review-${item.reportId}`}
                        onClick={() => setParams({ reportId: item.reportId })}
                      >
                        Review
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {cursor && (
          <button disabled={busy || loading} onClick={() => void more()}>
            Load more
          </button>
        )}
      </section>
      {error && <ErrorState title={error} />}
      {notice && <p role="status">{notice}</p>}
      {detailLoading && <LoadingState label="Loading saved report…" />}
      {detail && (
        <>
          <section className="panel" aria-label="Approval decision">
            <h2>
              Version {detail.summary.version} ·{' '}
              <span data-testid="approval-current-status">
                {label[detail.summary.approvalStatus]}
              </span>
            </h2>
            <p>Report ID: {detail.summary.reportId}</p>
            <p className="hint">
              The saved PDF is the original draft snapshot. The status above and the history below
              record its review.
            </p>
            {detail.summary.isProvisional && (
              <p className="hint">
                This report covers the month only through its cutoff; it is not a complete-month
                report.
              </p>
            )}
            {detail.summary.approvalStatus === 'draft' && (
              <button
                disabled={busy}
                data-testid="submit-approval"
                onClick={() => void act('submit')}
              >
                Submit for review
              </button>
            )}
            {detail.summary.approvalStatus === 'pending' && (
              <>
                <label>
                  Review note (required for rejection)
                  <textarea
                    className="approval-note"
                    aria-label="Review note"
                    value={reason}
                    maxLength={2000}
                    disabled={busy}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </label>
                <div className="actions-row">
                  <button
                    disabled={busy}
                    data-testid="approve-report"
                    onClick={() => void act('approve')}
                  >
                    Approve this version
                  </button>
                  <button
                    className="button--secondary"
                    disabled={busy || !reason.trim()}
                    data-testid="reject-report"
                    onClick={() => void act('reject')}
                  >
                    Reject this version
                  </button>
                </div>
              </>
            )}
            {detail.summary.approvalStatus === 'rejected' && (
              <p>
                Correct the source data and{' '}
                <Link to="/settlements">generate a new report version in Settlement Runs</Link>,
                then submit that version for review.
              </p>
            )}
            {detail.summary.approvalStatus === 'approved' && (
              <p>
                This version has been approved. A newly generated version requires a separate
                review.
              </p>
            )}
          </section>
          <ReportDetail report={detail.report} busy={busy} onDownload={() => void download()} />
          <section className="panel" aria-label="Approval history">
            <h2>Approval history</h2>
            {!detail.events.length ? (
              <p>No review actions yet.</p>
            ) : (
              <ol>
                {detail.events.map((event) => (
                  <li key={event.id}>
                    <strong>
                      {event.action === 'submit'
                        ? 'Submitted'
                        : event.action === 'approve'
                          ? 'Approved'
                          : 'Rejected'}
                    </strong>{' '}
                    · {event.actorId} · {time(event.createdAt)}
                    {event.reason && <p style={{ whiteSpace: 'pre-wrap' }}>{event.reason}</p>}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </>
      )}
    </div>
  );
}
