/** Number and date formatting in one place. NUMBER-NOT-A-DATE: the formatters below format money and counts, never times. */
const usd = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const usd2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 612000 -> "$612,000" (NUMBER-NOT-A-DATE) */
export function money(n: number | null | undefined, opts: { cents?: boolean } = {}): string {
  if (n == null || !Number.isFinite(n)) return 'n/a';
  return `$${(opts.cents ? usd2 : usd).format(n)}`;
}
/** 12345 -> "12,345" (NUMBER-NOT-A-DATE) */
export function count(n: number | null | undefined): string { return n == null || !Number.isFinite(n) ? '0' : usd.format(n); }

/** "2026-09-07" -> "Monday, September 7" on the Mountain Time wall clock. */
export function dayLabel(isoDate: string, opts: Intl.DateTimeFormatOptions = { weekday: 'long', month: 'long', day: 'numeric' }): string {
  return new Date(`${isoDate}T12:00:00-06:00`).toLocaleDateString('en-US', { ...opts, timeZone: 'America/Denver' });
}
