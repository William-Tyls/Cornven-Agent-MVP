import type { Request } from 'express';
import { ReportError } from './report-errors.js';
export type ReportActor = { id: string; artistIds: '*' | readonly string[] };
export type ResolveReportActor = (request: Request) => ReportActor | null;
export function requireArtist(actor: ReportActor, artistId: string) {
  if (actor.artistIds !== '*' && !actor.artistIds.includes(artistId)) {
    throw new ReportError(403, 'FORBIDDEN', 'You cannot access this artist.');
  }
}
export function developmentIdentity(): ResolveReportActor {
  const enabled =
    process.env.LOCAL_DEVELOPMENT_IDENTITY === 'true' && process.env.NODE_ENV !== 'production';
  return () => (enabled ? { id: 'local-demo-staff', artistIds: '*' } : null);
}
