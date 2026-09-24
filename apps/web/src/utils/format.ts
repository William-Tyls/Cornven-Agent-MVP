export function formatCents(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}

export function formatNullableCents(cents: number | null, currency: string): string {
  return cents === null ? 'Pending confirmation' : formatCents(cents, currency);
}

export function formatTaipeiTime(value: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Taipei',
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(new Date(value));
}
