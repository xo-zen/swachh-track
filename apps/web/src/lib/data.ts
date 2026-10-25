export type Row = Record<string, unknown>;
export interface PageResult { items: Row[]; nextCursor?: string | null }
export function record(value: unknown): Row { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}; }
export function text(value: unknown): string { return typeof value === 'string' || typeof value === 'number' ? String(value) : ''; }
export function number(value: unknown): number | null { if (value === null || value === undefined || value === '') return null; const result = Number(value); return Number.isFinite(result) ? result : null; }
export function rows(value: unknown): Row[] { return Array.isArray(value) ? value.map(record) : []; }
export function at(row: Row, path: string): unknown { return path.split('.').reduce<unknown>((value, key) => record(value)[key], row); }
export function display(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? '✓' : '—';
  if (Array.isArray(value)) return value.map(display).join(', ');
  if (typeof value === 'object') return Object.entries(record(value)).map(([key, item]) => `${key}: ${display(item)}`).join(' · ');
  return String(value);
}
export function date(value: unknown): string {
  const parsed = new Date(text(value));
  return Number.isNaN(parsed.getTime()) ? '—' : new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(parsed);
}
export function money(value: unknown): string { const amount = number(value); return amount === null ? '—' : new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(amount / 100); }
export function endpoint(path: string, params: Record<string, string | undefined> = {}): string {
  const query = new URLSearchParams(Object.entries(params).filter((entry): entry is [string, string] => Boolean(entry[1])));
  return query.size ? `${path}?${query}` : path;
}
export function safeUrl(value: unknown): string | undefined {
  try { const url = new URL(text(value)); return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined; } catch { return undefined; }
}
export function serverMetrics(value: unknown, prefix = ''): Row[] {
  if (Array.isArray(value)) return rows(value);
  return Object.entries(record(value)).flatMap(([key, item]) => {
    const row = record(item); const path = prefix ? `${prefix}.${key}` : key;
    return 'value' in row && 'provenance' in row && 'definition' in row ? [{ ...row, key: path }] : serverMetrics(row, path);
  });
}
