import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import type {
  ArtistListResponse,
  DeliveryConfig,
  DeliveryProfile,
  DeliveryRecord,
  ReportSummary,
} from '@cornven/contracts';
import { listArtists, listReports } from '../api/reports';
import {
  deliveryConfig,
  getDeliveryProfile,
  saveDeliveryProfile,
  listDeliveries,
  sendReport,
  retryDelivery,
} from '../api/delivery';
import { EmptyState, ErrorState, LoadingState } from '../components/StateViews';
const time = (s: string) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Taipei',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(s));
const message = (e: unknown) => (e instanceof Error ? e.message : 'Request failed.');
function stateLabel(row: DeliveryRecord) {
  if (row.status === 'sent')
    return row.mode === 'local' ? 'Captured locally' : 'Accepted by mail server';
  return {
    queued: 'Queued',
    sending: 'Sending',
    failed: 'Failed — retry available',
    unknown: 'Needs verification',
    skipped: 'Skipped',
  }[row.status];
}
export function DeliveriesPage() {
  const [config, setConfig] = useState<DeliveryConfig | null>(null);
  const [artists, setArtists] = useState<ArtistListResponse['items']>([]);
  const [artistCursor, setArtistCursor] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [artistId, setArtistId] = useState('');
  const [profile, setProfile] = useState<DeliveryProfile | null>(null);
  const [email, setEmail] = useState('');
  const [automatic, setAutomatic] = useState(false);
  const [reports, setReports] = useState<ReportSummary[]>([]);
  const [reportCursor, setReportCursor] = useState<string | null>(null);
  const [records, setRecords] = useState<DeliveryRecord[]>([]);
  const [deliveryCursor, setDeliveryCursor] = useState<string | null>(null);
  const [artistsLoading, setArtistsLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setArtistsLoading(true);
    setError(null);
    void Promise.all([deliveryConfig(), listArtists(query)])
      .then(([c, a]) => {
        if (!active) return;
        setConfig(c);
        setArtists(a.items);
        setArtistCursor(a.nextCursor);
        setArtistId((previous) =>
          a.items.some((item) => item.artistId === previous)
            ? previous
            : (a.items[0]?.artistId ?? ''),
        );
      })
      .catch((e) => {
        if (active) setError(message(e));
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
    setProfile(null);
    setReports([]);
    setRecords([]);
    setEmail('');
    setAutomatic(false);
    setReportCursor(null);
    setDeliveryCursor(null);
    setError(null);
    setNotice(null);
    if (!artistId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void Promise.all([
      getDeliveryProfile(artistId),
      listReports(artistId, ''),
      listDeliveries(new URLSearchParams({ artistId })),
    ])
      .then(([p, r, d]) => {
        if (!active) return;
        setProfile(p);
        setEmail(p.recipientEmail ?? '');
        setAutomatic(p.automaticEnabled);
        setReports(r.items);
        setReportCursor(r.nextCursor);
        setRecords(d.items);
        setDeliveryCursor(d.nextCursor);
      })
      .catch((e) => {
        if (active) setError(message(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [artistId, reload]);
  async function action(work: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
    } catch (e) {
      setError(message(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function refreshRecords() {
    const result = await listDeliveries(new URLSearchParams({ artistId }));
    setRecords(result.items);
    setDeliveryCursor(result.nextCursor);
  }
  const disabled = busy || loading || artistsLoading;
  const dirty =
    Boolean(profile) &&
    (email.trim() !== (profile?.recipientEmail ?? '') || automatic !== profile?.automaticEnabled);
  const approved = reports.filter(
    (r) => r.artistId === artistId && r.approvalStatus === 'approved',
  );
  return (
    <div className="page-wrap reports-page deliveries-page">
      <header className="page-head">
        <h1>Report Delivery</h1>
        <p>Send an approved report PDF manually, or enable monthly email delivery for an artist.</p>
      </header>
      {config && (
        <section className="panel">
          <h2>
            {config.mode === 'local'
              ? 'Local test inbox'
              : config.mode === 'smtp'
                ? 'Email delivery'
                : 'Email not configured'}
          </h2>
          <p>
            {config.mode === 'local'
              ? 'Emails and PDF attachments stay in the local test inbox; they are not delivered to external mailboxes.'
              : 'Sent means the mail server accepted the message; recipient inbox delivery is not confirmed.'}
          </p>
          <p>
            From: {config.from ?? 'Not configured'} ·{' '}
            {config.configured ? 'Configured' : 'Configuration required'}
          </p>
          {config.inboxUrl && (
            <a href={config.inboxUrl} target="_blank" rel="noreferrer">
              Open local inbox
            </a>
          )}
          <h3>Automatic delivery</h3>
          <p>
            Every month on day 1 at 10:00 (Asia/Taipei). Next scheduled run:{' '}
            {time(config.nextScheduledAt)}.
          </p>
          <p className="hint">
            For each enabled artist, send the latest approved complete report for the previous
            month. Reports approved after the deadline are skipped for that run and can be sent
            manually. The local server must be running; on restart it can catch up the current
            month's run.
          </p>
        </section>
      )}
      <section className="panel">
        <h2>Artist and recipient</h2>
        <form
          className="actions-row"
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(search);
          }}
        >
          <label>
            Search artists
            <input value={search} disabled={disabled} onChange={(e) => setSearch(e.target.value)} />
          </label>
          <button disabled={disabled}>Search</button>
        </form>
        <label>
          Artist
          <select
            aria-label="Delivery artist"
            value={artistId}
            disabled={disabled}
            onChange={(e) => setArtistId(e.target.value)}
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
        {artistCursor && (
          <button
            disabled={disabled}
            onClick={() =>
              void action(async () => {
                const a = await listArtists(query, artistCursor);
                setArtists((old) => [...old, ...a.items]);
                setArtistCursor(a.nextCursor);
              })
            }
          >
            Load more artists
          </button>
        )}
        {profile && (
          <form
            className="delivery-profile"
            onSubmit={(e) => {
              e.preventDefault();
              void action(async () => {
                const saved = await saveDeliveryProfile(artistId, {
                  recipientEmail: email.trim() || null,
                  automaticEnabled: automatic,
                });
                setProfile(saved);
                setEmail(saved.recipientEmail ?? '');
                setAutomatic(saved.automaticEnabled);
                setNotice('Recipient settings saved.');
              });
            }}
          >
            <label>
              Recipient email
              <input
                aria-label="Recipient email"
                type="email"
                maxLength={254}
                value={email}
                disabled={disabled}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="artist@example.com"
              />
            </label>
            <label className="delivery-toggle">
              <input
                type="checkbox"
                aria-label="Enable automatic delivery"
                checked={automatic}
                disabled={disabled}
                onChange={(e) => setAutomatic(e.target.checked)}
              />{' '}
              Enable monthly automatic delivery
            </label>
            <button
              disabled={disabled || !dirty || (automatic && !email.trim())}
              data-testid="save-delivery-profile"
            >
              Save recipient settings
            </button>
          </form>
        )}
      </section>
      {error && <ErrorState title={error} />}
      {notice && <p role="status">{notice}</p>}
      {loading && <LoadingState label="Loading delivery data…" />}
      <section className="panel">
        <h2>Send an approved PDF</h2>
        <p>
          Recipient: <strong>{profile?.recipientEmail ?? 'Save a recipient email first'}</strong>
        </p>
        {dirty && <p className="hint">Save recipient changes before sending.</p>}
        {!loading && !approved.length && (
          <EmptyState label="No approved reports on this page. Approve a saved version in Approvals, or load more reports." />
        )}
        {!!approved.length && (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Month</th>
                  <th>Version</th>
                  <th>Cutoff (Taipei)</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {approved.map((r) => {
                  const delivery = records.find(
                    (d) =>
                      d.reportId === r.reportId &&
                      d.recipientEmail === profile?.recipientEmail &&
                      d.mode === config?.mode &&
                      d.status !== 'skipped',
                  );
                  return (
                    <tr key={r.reportId}>
                      <td>
                        {r.settlementMonth}
                        {r.isProvisional ? ' · Month to date' : ''}
                      </td>
                      <td>{r.version}</td>
                      <td>{time(r.asOf)}</td>
                      <td>
                        <Link to={`/approvals?reportId=${r.reportId}`}>Review report</Link>{' '}
                        <button
                          data-testid={`send-report-${r.reportId}`}
                          disabled={
                            disabled ||
                            dirty ||
                            !config?.configured ||
                            !profile?.recipientEmail ||
                            profile.artistId !== artistId ||
                            Boolean(delivery)
                          }
                          onClick={() =>
                            void action(async () => {
                              const sent = await sendReport(r.reportId);
                              await refreshRecords();
                              setNotice(`Version ${r.version}: ${stateLabel(sent)}.`);
                            })
                          }
                        >
                          {delivery
                            ? stateLabel(delivery)
                            : config?.mode === 'local'
                              ? 'Send PDF to local inbox'
                              : 'Send PDF by email'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {reportCursor && (
          <button
            disabled={disabled}
            onClick={() =>
              void action(async () => {
                const r = await listReports(artistId, '', reportCursor);
                setReports((old) => [...old, ...r.items]);
                setReportCursor(r.nextCursor);
              })
            }
          >
            Load more reports
          </button>
        )}
        <p className="hint">
          Each report version is sent once per recipient and channel. Manual and automatic sends
          share this check.
        </p>
      </section>
      <section className="panel">
        <h2>Delivery history</h2>
        <button disabled={disabled} onClick={() => setReload((n) => n + 1)}>
          Refresh status
        </button>
        {!loading && !records.length && <EmptyState label="No deliveries for this artist yet." />}
        {!!records.length && (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Report</th>
                  <th>Recipient</th>
                  <th>Source</th>
                  <th>Status</th>
                  <th>Time (Taipei)</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {records.map((d) => (
                  <tr key={d.id} data-testid={`delivery-${d.id}`}>
                    <td>
                      {d.settlementMonth}
                      {d.version ? ` · v${d.version}` : ''}
                    </td>
                    <td>{d.recipientEmail ?? 'Missing'}</td>
                    <td>{d.trigger === 'manual' ? 'Manual' : 'Scheduled'}</td>
                    <td>{stateLabel(d)}</td>
                    <td>{time(d.sentAt ?? d.createdAt)}</td>
                    <td>
                      {d.errorMessage && <p>{d.errorMessage}</p>}
                      <span>{d.attemptCount} attempt(s)</span>
                      {d.status === 'failed' && (
                        <button
                          disabled={disabled || d.mode !== config?.mode}
                          onClick={() =>
                            void action(async () => {
                              const result = await retryDelivery(d.id);
                              await refreshRecords();
                              setNotice(stateLabel(result));
                            })
                          }
                        >
                          Retry failed delivery
                        </button>
                      )}
                      {d.reportId && (
                        <p>
                          <Link to={`/approvals?reportId=${d.reportId}`}>Report and approval</Link>
                        </p>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {deliveryCursor && (
          <button
            disabled={disabled}
            onClick={() =>
              void action(async () => {
                const q = new URLSearchParams({ artistId, cursor: deliveryCursor });
                const d = await listDeliveries(q);
                setRecords((old) => [...old, ...d.items]);
                setDeliveryCursor(d.nextCursor);
              })
            }
          >
            Load more deliveries
          </button>
        )}
      </section>
    </div>
  );
}
