import { describe, expect, it } from 'vitest';
import { csv } from '../src/csv.js';

describe('safe CSV exports', () => {
  it('preserves column order and escapes quotes, commas and embedded lines', () => {
    expect(csv(['name', 'note'], [{ note: 'line 1\nline 2', name: 'A, "B"' }]))
      .toBe('"name","note"\r\n"A, ""B""","line 1\nline 2"');
  });
  it('serializes dates, zero, null and missing values without dropping columns', () => {
    expect(csv(['date', 'amount', 'empty', 'missing'], [{ date: new Date('2025-02-01T00:00:00Z'), amount: 0, empty: null }]))
      .toBe('"date","amount","empty","missing"\r\n"2025-02-01T00:00:00.000Z","0","",""');
  });
  it.each(['=1+1', '+1+1', '-1+1', '@SUM(A1)', '  =1+1', '\ttext', '\rtext', '\ntext'])('neutralizes spreadsheet control text %j', value => {
    expect(csv(['reference'], [{ reference: value }])).toBe(`"reference"\r\n"'${value}"`);
  });
  it('emits headers for an empty export', () => {
    expect(csv(['id', 'amountPaise'], [])).toBe('"id","amountPaise"');
  });
});
