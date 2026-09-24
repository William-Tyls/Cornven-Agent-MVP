export function toDatabaseCents(value: number): bigint {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError('Money cents must be a safe integer before database conversion.');
  }
  return BigInt(value);
}

export function fromDatabaseCents(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) {
    throw new RangeError('Database money cents cannot be represented safely in the API contract.');
  }
  return result;
}
