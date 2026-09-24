import { describe, expect, it } from 'vitest';
import { monthAt, monthBounds, reportRange, shiftMonth } from '../../shared/report-time.js';
import { decodeCursor, encodeCursor } from '../../shared/report-cursor.js';
import { requireArtist } from '../../shared/report-auth.js';

describe('report scope and trusted access', () => {
  it('AC-02/03: uses Taipei month and an inclusive cutoff before the next month', () => {
    expect(monthAt(new Date('2026-08-31T16:00:00Z'))).toBe('2026-09');
    expect(reportRange('2026-08', '2026-09-01T00:00:00+08:00').cutoff.toISOString()).toBe(
      '2026-08-31T15:59:59.999Z',
    );
    expect(reportRange('2026-08', '2026-08-18T10:00:00+08:00').cutoff.toISOString()).toBe(
      '2026-08-18T02:00:00.000Z',
    );
  });
  it('AC-04: crosses years and handles leap months', () => {
    expect(shiftMonth('2027-01', -1)).toBe('2026-12');
    const { start, end } = monthBounds('2028-02');
    expect((end.getTime() - start.getTime()) / 86400000).toBe(29);
  });
  it('binds pagination to the query and rejects malformed cursors', () => {
    const cursor = encodeCursor('artist-a', 'report-a', '2026-09-01T00:00:00.000Z');
    expect(decodeCursor(cursor, 'artist-a')?.id).toBe('report-a');
    expect(() => decodeCursor(cursor, 'artist-b')).toThrow();
    expect(() => decodeCursor('not-a-cursor', 'artist-a')).toThrow();
  });
  it('AC-11: enforces the trusted actor scope', () => {
    expect(() => requireArtist({ id: 'staff', artistIds: ['a'] }, 'b')).toThrow();
    expect(() => requireArtist({ id: 'staff', artistIds: ['a'] }, 'a')).not.toThrow();
  });
});
