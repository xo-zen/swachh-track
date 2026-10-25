import { describe, expect, it } from 'vitest';
import { at, date, endpoint, money, number, record, safeUrl, serverMetrics } from './data';

describe('web presentation helpers', () => {
  it('preserves missing measurements instead of inventing zeros', () => {
    expect(number(null)).toBeNull(); expect(number(undefined)).toBeNull(); expect(number('')).toBeNull();
    expect(number('0')).toBe(0); expect(number('not measured')).toBeNull();
  });
  it('formats paise as INR without recomputing financial totals', () => {
    expect(money(123456)).toContain('1,234.56'); expect(money(null)).toBe('—');
  });
  it('renders UTC instants in IST', () => { expect(date('2026-01-01T00:00:00Z')).toMatch(/5:30|05:30/); expect(date('invalid')).toBe('—'); });
  it('escapes query parameters and omits empty filters', () => { expect(endpoint('/properties', { search: 'A & B', status: undefined })).toBe('/properties?search=A+%26+B'); });
  it('rejects active-content URLs', () => { expect(safeUrl('javascript:alert(1)')).toBeUndefined(); expect(safeUrl('data:text/html,test')).toBeUndefined(); expect(safeUrl('https://private.example/photo')).toBe('https://private.example/photo'); });
  it('narrows unknown records and nested access safely', () => { expect(record(null)).toEqual({}); expect(at({ property: { unitNo: 'A-1' } }, 'property.unitNo')).toBe('A-1'); expect(at({}, 'property.unitNo')).toBeUndefined(); });
  it('flattens server metrics without recomputing them', () => {
    const metric = { value: null, unit: '%', provenance: 'NOT_MEASURED', definition: 'Requires receipts', sourceIds: [] };
    expect(serverMetrics({ massBalance: { recycling: metric } })).toEqual([{ ...metric, key: 'massBalance.recycling' }]);
    expect(serverMetrics({})).toEqual([]);
  });
});
