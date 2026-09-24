import { describe, expect, it } from 'vitest';

import { fromDatabaseCents, toDatabaseCents } from './money.js';

describe('database money boundary', () => {
  it('round-trips the maximum Decimal(10,2) amount in cents', () => {
    const cents = 9_999_999_999;
    expect(fromDatabaseCents(toDatabaseCents(cents))).toBe(cents);
  });

  it('rejects unsafe API numbers', () => {
    expect(() => toDatabaseCents(Number.MAX_SAFE_INTEGER + 1)).toThrow('safe integer');
    expect(() => fromDatabaseCents(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow(
      'represented safely',
    );
  });
});
