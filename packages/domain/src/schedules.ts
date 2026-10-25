import type { ScheduleInput } from '@swachh/contracts';
import { DAY_MS, IST_OFFSET_MS, calendarDay, integer, istDate, timestamp } from './primitives';

export function isScheduledOn(schedule: ScheduleInput, date: string): boolean {
  const day = calendarDay(date);
  const start = calendarDay(schedule.activeFrom);
  const end = schedule.activeTo ? calendarDay(schedule.activeTo) : Infinity;
  if (end < start) throw new RangeError('Schedule ends before it starts');
  if (schedule.pattern.type === 'EVERY_N_DAYS') {
    integer(schedule.pattern.everyNDays, 'Cycle');
    if (schedule.pattern.everyNDays < 1) throw new RangeError('Cycle must be positive');
    return day >= start && day <= end && ((day - start) / DAY_MS) % schedule.pattern.everyNDays === 0;
  }
  if (!schedule.pattern.weekdays.length || schedule.pattern.weekdays.some(value => !Number.isInteger(value) || value < 0 || value > 6)) throw new RangeError('Invalid weekdays');
  return day >= start && day <= end && schedule.pattern.weekdays.includes(new Date(day).getUTCDay());
}
function minutes(value: string): number {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new RangeError('Expected HH:mm');
  const [hours, mins] = value.split(':').map(Number);
  return hours * 60 + mins;
}
export function scheduledWindow(schedule: ScheduleInput, date: string): { start: string; end: string } | null {
  if (!isScheduledOn(schedule, date)) return null;
  const start = minutes(schedule.windowStart);
  const end = minutes(schedule.windowEnd);
  if (end <= start) throw new RangeError('Schedule windows must end on the same IST day after their start');
  const midnight = calendarDay(date) - IST_OFFSET_MS;
  return { start: new Date(midnight + start * 60_000).toISOString(), end: new Date(midnight + end * 60_000).toISOString() };
}
export function nextScheduledPickup(schedule: ScheduleInput, from: string, maxDays = 366): { date: string; start: string; end: string } | null {
  integer(maxDays, 'Search days');
  if (maxDays < 1 || maxDays > 3660) throw new RangeError('Search days must be 1 to 3660');
  const instant = timestamp(from);
  const firstDay = Math.max(calendarDay(istDate(from)), calendarDay(schedule.activeFrom));
  for (let offset = 0; offset < maxDays; offset++) {
    const date = new Date(firstDay + offset * DAY_MS).toISOString().slice(0, 10);
    const window = scheduledWindow(schedule, date);
    if (window && timestamp(window.end) >= instant) return { date, ...window };
  }
  return null;
}

export function isQuietHours(instant: string, start = '21:00', end = '07:00'): boolean {
  const date = new Date(timestamp(instant) + IST_OFFSET_MS);
  const localMinute = date.getUTCHours() * 60 + date.getUTCMinutes();
  const startMinute = minutes(start);
  const endMinute = minutes(end);
  if (startMinute === endMinute) return false;
  return startMinute < endMinute ? localMinute >= startMinute && localMinute < endMinute : localMinute >= startMinute || localMinute < endMinute;
}
export function notificationDeliveryAt(instant: string, template: string, start = '21:00', end = '07:00'): string {
  const now = timestamp(instant);
  if (template === 'SLA_BREACH' || !isQuietHours(instant, start, end)) return new Date(now).toISOString();
  const local = new Date(now + IST_OFFSET_MS);
  const endMinute = minutes(end);
  let due = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) + endMinute * 60_000 - IST_OFFSET_MS;
  if (due <= now) due += DAY_MS;
  return new Date(due).toISOString();
}
