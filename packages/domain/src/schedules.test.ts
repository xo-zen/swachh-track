import { describe, expect, it } from 'vitest';
import type { ScheduleInput } from '@swachh/contracts';
import { isQuietHours, isScheduledOn, istDate, nextScheduledPickup, notificationDeliveryAt, scheduledWindow } from './index';

const weekly: ScheduleInput = { stream: 'WET', pattern: { type: 'WEEKLY', weekdays: [1, 4] }, windowStart: '08:00', windowEnd: '10:00', activeFrom: '2026-01-01', activeTo: '2026-01-31' };
describe('IST schedules', () => {
  it('uses Sunday-zero weekdays and inclusive active range', () => {
    expect(isScheduledOn(weekly, '2026-01-01')).toBe(true);
    expect(isScheduledOn(weekly, '2026-01-05')).toBe(true);
    expect(isScheduledOn(weekly, '2026-01-06')).toBe(false);
    expect(isScheduledOn(weekly, '2025-12-29')).toBe(false);
    expect(isScheduledOn(weekly, '2026-02-02')).toBe(false);
    expect(isScheduledOn({ ...weekly, pattern: { type: 'WEEKLY', weekdays: [0] } }, '2026-01-04')).toBe(true);
  });
  it('anchors every-N-days to activeFrom across month and leap boundaries', () => {
    const cycle: ScheduleInput = { ...weekly, activeFrom: '2024-02-27', activeTo: '2024-04-01', pattern: { type: 'EVERY_N_DAYS', everyNDays: 4 } };
    expect(isScheduledOn(cycle, '2024-02-27')).toBe(true);
    expect(isScheduledOn(cycle, '2024-03-02')).toBe(true);
    expect(isScheduledOn(cycle, '2024-03-01')).toBe(false);
    expect(() => isScheduledOn({ ...cycle, pattern: { type: 'EVERY_N_DAYS', everyNDays: 0 } }, '2024-03-02')).toThrow();
    expect(() => isScheduledOn(cycle, '2025-02-29')).toThrow();
  });
  it('returns UTC windows and includes an ongoing pickup window', () => {
    expect(scheduledWindow(weekly, '2026-01-01')).toEqual({ start: '2026-01-01T02:30:00.000Z', end: '2026-01-01T04:30:00.000Z' });
    expect(scheduledWindow(weekly, '2026-01-02')).toBeNull();
    expect(nextScheduledPickup(weekly, '2026-01-01T03:00:00Z')?.date).toBe('2026-01-01');
    expect(nextScheduledPickup(weekly, '2026-01-01T04:30:00.001Z')?.date).toBe('2026-01-05');
    expect(nextScheduledPickup(weekly, '2026-02-01T00:00:00Z')).toBeNull();
    expect(nextScheduledPickup(weekly, '2025-12-01T00:00:00Z')?.date).toBe('2026-01-01');
    expect(() => scheduledWindow({ ...weekly, windowEnd: '07:00' }, '2026-01-01')).toThrow();
  });
});

describe('notification quiet hours', () => {
  it('uses default 21:00 inclusive to 07:00 exclusive IST', () => {
    expect(istDate('2026-01-01T19:00:00Z')).toBe('2026-01-02');
    expect(isQuietHours('2026-01-01T15:29:59Z')).toBe(false);
    expect(isQuietHours('2026-01-01T15:30:00Z')).toBe(true);
    expect(isQuietHours('2026-01-02T01:29:59Z')).toBe(true);
    expect(isQuietHours('2026-01-02T01:30:00Z')).toBe(false);
  });
  it('defers ordinary notifications to the correct next local morning but never SLA breaches', () => {
    expect(notificationDeliveryAt('2026-01-01T16:00:00Z', 'PICKUP_COMPLETED')).toBe('2026-01-02T01:30:00.000Z');
    expect(notificationDeliveryAt('2026-01-02T00:00:00Z', 'PICKUP_COMPLETED')).toBe('2026-01-02T01:30:00.000Z');
    expect(notificationDeliveryAt('2026-01-01T16:00:00Z', 'SLA_BREACH')).toBe('2026-01-01T16:00:00.000Z');
    expect(notificationDeliveryAt('2026-01-02T02:00:00Z', 'PICKUP_COMPLETED')).toBe('2026-01-02T02:00:00.000Z');
  });
  it('supports same-day quiet hours, disabling with equal boundaries and rejects invalid times', () => {
    expect(notificationDeliveryAt('2026-01-01T07:00:00Z', 'REMINDER', '12:00', '14:00')).toBe('2026-01-01T08:30:00.000Z');
    expect(isQuietHours('2026-01-01T07:00:00Z', '12:00', '12:00')).toBe(false);
    expect(() => isQuietHours('2026-01-01T07:00:00Z', '24:00', '07:00')).toThrow();
  });
});
