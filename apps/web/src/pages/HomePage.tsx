import { useState } from 'react';
import { Link } from 'react-router';

import { apiRequest } from '../api/client';
import { AlertIcon, ChatIcon, CheckCircleIcon, ListIcon, UploadIcon } from '../components/icons';

type ApiState = 'not-checked' | 'checking' | 'ready' | 'unavailable';

const quickActions = [
  { to: '/import', label: 'Import CSV', icon: UploadIcon },
  { to: '/settlements', label: 'Preview / Save Reports', icon: ListIcon },
  { to: '/approvals', label: 'Review Approvals', icon: CheckCircleIcon },
  { to: '/assistant', label: 'Ask Assistant', icon: ChatIcon },
];

export function HomePage() {
  const [apiState, setApiState] = useState<ApiState>('not-checked');

  async function checkApi() {
    setApiState('checking');

    try {
      await apiRequest<{ status: string }>('/api/v1/health');
      setApiState('ready');
    } catch {
      setApiState('unavailable');
    }
  }

  return (
    <div className="page-wrap">
      <header className="page-head">
        <h1>Dashboard</h1>
        <p>
          Plan B workspace: import CSV transactions, preview settlements, save reports and ask the
          assistant about settlements or operating procedures. Review saved report versions in
          Approvals.
        </p>
      </header>

      <section className="panel">
        <h2 className="panel__title">Quick Actions</h2>
        <div className="tile-grid">
          {quickActions.map((action) => {
            const ActionIcon = action.icon;
            return (
              <Link className="tile" to={action.to} key={action.to}>
                <ActionIcon className="tile__icon" />
                <span>{action.label}</span>
              </Link>
            );
          })}
        </div>
      </section>

      <section className="panel">
        <h2 className="panel__title">System Status</h2>
        <div className="status-row">
          <div className="status-row__info">
            <p className="status-row__label">Local API</p>
            <p className="status-row__hint">
              Checks <code>GET /api/v1/health</code> against{' '}
              {import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:3119'}.
            </p>
          </div>
          <button type="button" onClick={checkApi} disabled={apiState === 'checking'}>
            {apiState === 'checking' ? 'Checking…' : 'Check API'}
          </button>
          <span className={`status-pill status-pill--${apiState}`}>
            {apiState.replace('-', ' ')}
          </span>
        </div>

        {apiState === 'unavailable' && (
          <div className="callout callout--warning">
            <AlertIcon />
            <span>
              API is unreachable. Start it with <code>pnpm local:start</code> from the repository
              root.
            </span>
          </div>
        )}

        {apiState === 'not-checked' && (
          <div className="empty-block">
            <CheckCircleIcon className="empty-block__icon" />
            <p>No checks run yet</p>
            <p className="empty-block__hint">Click "Check API" to confirm the backend is up.</p>
          </div>
        )}
      </section>

      <section className="panel">
        <h2 className="panel__title">Module ownership</h2>
        <div className="module-row">
          <span>
            <strong>A</strong> Platform + POS
          </span>
          <span>
            <strong>B</strong> Settlement
          </span>
          <span>
            <strong>C</strong> AI Assistant
          </span>
          <span>
            <strong>D</strong> Web + Quality
          </span>
        </div>
      </section>
    </div>
  );
}
