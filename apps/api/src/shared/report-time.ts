import { SettlementMonthSchema } from '@cornven/contracts';
export function monthAt(date: Date): string {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 7);
}
export function shiftMonth(month: string, delta: number): string {
  SettlementMonthSchema.parse(month);
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1 + delta, 1)).toISOString().slice(0, 7);
}
export function monthBounds(month: string) {
  SettlementMonthSchema.parse(month);
  return {
    start: new Date(`${month}-01T00:00:00+08:00`),
    end: new Date(`${shiftMonth(month, 1)}-01T00:00:00+08:00`),
  };
}
export function reportRange(month: string, asOf: string) {
  const { start, end } = monthBounds(month);
  return { start, end, cutoff: new Date(Math.min(Date.parse(asOf), end.getTime() - 1)) };
}
