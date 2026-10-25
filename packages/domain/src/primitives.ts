export const DAY_MS = 86_400_000;
export const IST_OFFSET_MS = 19_800_000;

export function timestamp(value: string): number {
  const result = Date.parse(value);
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/.test(value) || !Number.isFinite(result)) throw new RangeError('Expected an ISO timestamp with timezone');
  calendarDay(value.slice(0, 10));
  return result;
}

export function calendarDay(value: string): number {
  const result = Date.parse(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(result) || new Date(result).toISOString().slice(0, 10) !== value) throw new RangeError('Invalid calendar date');
  return result;
}

export function nonnegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be finite and nonnegative`);
  return value;
}

export function integer(value: number, name: string): number {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${name} must be a safe integer`);
  return value;
}

export function kgToGrams(kg: number): number {
  nonnegative(kg, 'kg');
  const grams = Math.round(kg * 1000);
  if (kg > 9_999_999.999 || Math.abs(grams - kg * 1000) >= 0.00001) throw new RangeError('kg must fit numeric(10,3)');
  return integer(grams, 'grams');
}

export function sumKg(values: readonly number[]): number {
  return integer(values.reduce((sum, kg) => sum + kgToGrams(kg), 0), 'total grams') / 1000;
}

export function istDate(instant: string): string {
  return new Date(timestamp(instant) + IST_OFFSET_MS).toISOString().slice(0, 10);
}
