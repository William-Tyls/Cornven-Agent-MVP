import type { ReactNode } from 'react';

import type { ApiErrorDetail } from '../api/client';

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="state-view state-view--loading" role="status">
      {label}
    </div>
  );
}

export function EmptyState({ label }: { label: string }) {
  return (
    <div className="state-view state-view--empty" role="status">
      {label}
    </div>
  );
}

export function ErrorState({
  title = 'Something went wrong.',
  requestId,
  details,
}: {
  title?: string;
  requestId?: string | undefined;
  details?: ApiErrorDetail[] | undefined;
}) {
  return (
    <div className="state-view state-view--error" role="alert">
      <p className="state-view__title">{title}</p>
      {details && details.length > 0 && (
        <ul>
          {details.map((detail, index) => (
            <li key={index}>
              {detail.field ? `${detail.field}: ` : ''}
              {detail.reason}
            </li>
          ))}
        </ul>
      )}
      {requestId && <p className="state-view__meta">Request ID: {requestId}</p>}
    </div>
  );
}

export function PendingApprovalBadge(): ReactNode {
  return <span className="badge badge--pending">Pending human approval</span>;
}
