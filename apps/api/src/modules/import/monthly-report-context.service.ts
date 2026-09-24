import {
  SettlementPreviewInputSchema,
  type CanonicalSale,
  type SettlementPreviewInput,
} from '@cornven/contracts';

export type MonthlyReportContextInput = {
  artistId: string;
  artistName?: string;
  brandName?: string | null;
  settlementMonth: string;
  asOf: string;
  records: CanonicalSale[];
  rentals?: SettlementPreviewInput['rentals'];
  bankTransferFeeCents?: number | null;
  inventory?: SettlementPreviewInput['inventory'];
};

function getTaipeiMonthBounds(settlementMonth: string): {
  start: Date;
  end: Date;
} {
  const match = /^(\d{4})-(\d{2})$/.exec(settlementMonth);

  if (!match) {
    throw new Error(`Invalid settlement month: ${settlementMonth}`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);

  if (month < 1 || month > 12) {
    throw new Error(`Invalid settlement month: ${settlementMonth}`);
  }

  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;

  return {
    start: new Date(`${settlementMonth}-01T00:00:00+08:00`),
    end: new Date(`${nextYear}-${String(nextMonth).padStart(2, '0')}-01T00:00:00+08:00`),
  };
}

export function buildMonthlyReportContext(
  input: MonthlyReportContextInput,
): SettlementPreviewInput {
  const { start, end } = getTaipeiMonthBounds(input.settlementMonth);
  const asOf = new Date(input.asOf);

  if (Number.isNaN(asOf.getTime())) {
    throw new Error(`Invalid asOf timestamp: ${input.asOf}`);
  }

  const eligibleRecords = input.records.filter(
    (record) => record.artistId === input.artistId && new Date(record.soldAt) <= asOf,
  );

  const sales = eligibleRecords.filter((record) => {
    const soldAt = new Date(record.soldAt);

    return soldAt >= start && soldAt < end;
  });

  const parentTransactionIds = new Set(
    sales
      .filter((record) => record.recordType === 'refund')
      .map((record) => record.parentTransactionId)
      .filter((transactionId): transactionId is string => transactionId != null),
  );

  const historicalRecords = eligibleRecords.filter((record) => {
    const soldAt = new Date(record.soldAt);

    if (soldAt >= start) {
      return false;
    }

    return (
      parentTransactionIds.has(record.sourceTransactionId) ||
      (record.recordType === 'refund' &&
        record.parentTransactionId != null &&
        parentTransactionIds.has(record.parentTransactionId))
    );
  });

  return SettlementPreviewInputSchema.parse({
    artistId: input.artistId,
    ...(input.artistName ? { artistName: input.artistName } : {}),
    brandName: input.brandName ?? null,
    settlementMonth: input.settlementMonth,
    asOf: input.asOf,
    businessTimezone: 'Asia/Taipei',
    currency: 'TWD',
    sales,
    historicalRecords,
    rentals: input.rentals ?? [],
    bankTransferFeeCents: input.bankTransferFeeCents ?? null,
    inventory: input.inventory ?? null,
  });
}
