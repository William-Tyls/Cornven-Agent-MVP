/**
 * Builds the field values for a REFUND Sale record, given the raw POS
 * refund record and the original SALE record it references.
 *
 * Per the client's confirmed rule: a cross-month refund must use the
 * Commission Rate that was in effect at the time of the ORIGINAL sale,
 * not whatever rate is currently configured on the Rental. This is
 * enforced by copying rentalCommissionBps (and cubeCommissionBps) directly
 * from the parent SALE record, never re-reading the Rental's current rate.
 */

export interface ParentSaleSnapshot {
  id: string;
  unitPriceCents: bigint;
  rentalCommissionBps: number;
  cubeCommissionBps: number | null;
}

export interface RefundSourceRecord {
  sourceRecordId: string;
  sourceTransactionId: string;
  quantity: number;
  // Optional here to match the shape of the raw fixture record type, which
  // must also represent EXCHANGE records (no monetary fields). Callers
  // processing a REFUND record are expected to always provide these.
  totalAmount?: string;
  commissionAmount?: string;
  tenantAmount?: string;
  currency: string;
  cubeId?: string | null;
  occurredAt: string;
}

export interface RefundSaleFields {
  parentSaleId: string;
  unitPriceCents: bigint;
  rentalCommissionBps: number;
  cubeCommissionBps: number | null;
  currency: string;
  recordType: 'REFUND';
}

export function buildRefundSaleFields(
  parentSale: ParentSaleSnapshot,
  record: RefundSourceRecord,
): RefundSaleFields {
  return {
    parentSaleId: parentSale.id,
    unitPriceCents: parentSale.unitPriceCents,
    // Client-confirmed rule: cross-month refunds use the ORIGINAL sale's
    // rate, never the Rental's current rate.
    rentalCommissionBps: parentSale.rentalCommissionBps,
    cubeCommissionBps: parentSale.cubeCommissionBps,
    currency: record.currency,
    recordType: 'REFUND',
  };
}
