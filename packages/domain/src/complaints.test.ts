import { describe, expect, it } from 'vitest';
import { calculateSla, slaEscalation, transitionComplaint, type ComplaintState } from './index';

const createdAt = '2026-01-01T00:00:00Z';
const base: ComplaintState = { createdAt, slaHours: 12, pauses: [], status: 'OPEN', reopenedCount: 0 };
describe('SLA clock', () => {
  it('uses configurable hours, exact deadlines, positive breach and freezes at resolution', () => {
    expect(calculateSla(base, '2026-01-01T12:00:00Z')).toMatchObject({ dueAt: '2026-01-01T12:00:00.000Z', remainingMs: 0, breached: false });
    expect(calculateSla(base, '2026-01-01T12:00:00.001Z').breached).toBe(true);
    expect(calculateSla({ ...base, slaHours: 48 }, '2026-01-01T12:00:00Z').dueAt).toBe('2026-01-03T00:00:00.000Z');
    expect(calculateSla({ ...base, resolvedAt: '2026-01-01T11:00:00Z' }, '2026-02-01T00:00:00Z')).toMatchObject({ elapsedMs: 39_600_000, breached: false, resolved: true });
  });
  it('subtracts completed and active resident-wait pauses without masking a prior breach', () => {
    const paused = { ...base, pauses: [{ startedAt: '2026-01-01T02:00:00Z', endedAt: '2026-01-01T04:00:00Z', reason: 'Need resident access' }, { startedAt: '2026-01-01T05:00:00Z', reason: 'Resident evidence requested' }] };
    expect(calculateSla(paused, '2026-01-01T08:00:00Z')).toMatchObject({ dueAt: '2026-01-01T17:00:00.000Z', elapsedMs: 10_800_000, pausedMs: 18_000_000, paused: true, breached: false });
    expect(calculateSla({ ...base, pauses: [{ startedAt: '2026-01-01T13:00:00Z', reason: 'Too late to hide breach' }] }, '2026-01-01T15:00:00Z').breached).toBe(true);
  });
  it('rejects reasonless, overlapping, reversed and future pauses', () => {
    expect(() => calculateSla({ ...base, pauses: [{ startedAt: createdAt, reason: '' }] }, createdAt)).toThrow();
    expect(() => calculateSla({ ...base, pauses: [{ startedAt: '2026-01-01T01:00:00Z', endedAt: '2026-01-01T03:00:00Z', reason: 'first' }, { startedAt: '2026-01-01T02:00:00Z', reason: 'overlap' }] }, '2026-01-01T05:00:00Z')).toThrow();
    expect(() => calculateSla({ ...base, pauses: [{ startedAt: '2026-01-02T00:00:00Z', reason: 'future' }] }, createdAt)).toThrow();
    expect(() => calculateSla({ ...base, slaHours: 0 }, createdAt)).toThrow();
    expect(() => calculateSla(base, '2025-12-31T00:00:00Z')).toThrow();
  });
  it('escalates in order, with no escalation for resolved or unbreached complaints', () => {
    const now = '2026-01-01T14:00:00Z';
    const sla = calculateSla(base, now);
    expect(slaEscalation(sla, now)).toBe('SUPERVISOR');
    expect(slaEscalation(sla, now, '2026-01-01T13:00:00Z')).toBe('ULB_ADMIN');
    expect(slaEscalation(sla, now, '2026-01-01T13:30:00Z')).toBeNull();
    expect(slaEscalation({ ...sla, resolved: true }, now)).toBeNull();
    expect(slaEscalation({ ...sla, breached: false }, now)).toBeNull();
  });
});

describe('complaint workflow and one reopen', () => {
  it('enforces progression, reasoned resident wait, resume and resolution proof immutably', () => {
    const ack = transitionComplaint(base, { to: 'ACKNOWLEDGED', at: '2026-01-01T01:00:00Z', actorRole: 'SOCIETY_ADMIN' }).complaint;
    const progress = transitionComplaint(ack, { to: 'IN_PROGRESS', at: '2026-01-01T02:00:00Z', actorRole: 'SUPERVISOR' }).complaint;
    expect(() => transitionComplaint(progress, { to: 'WAITING_FOR_RESIDENT', at: '2026-01-01T03:00:00Z', actorRole: 'SUPERVISOR' })).toThrow('reason');
    const waiting = transitionComplaint(progress, { to: 'WAITING_FOR_RESIDENT', at: '2026-01-01T03:00:00Z', actorRole: 'SUPERVISOR', note: 'Please allow access' }).complaint;
    expect(waiting.waitingFrom).toBe('IN_PROGRESS');
    expect(() => transitionComplaint(waiting, { to: 'ACKNOWLEDGED', at: '2026-01-01T05:00:00Z', actorRole: 'SUPERVISOR' })).toThrow('Resume');
    const resumed = transitionComplaint(waiting, { to: 'IN_PROGRESS', at: '2026-01-01T05:00:00Z', actorRole: 'SUPERVISOR' }).complaint;
    expect(resumed.pauses[0].endedAt).toBe('2026-01-01T05:00:00Z');
    expect(waiting.pauses[0].endedAt).toBeUndefined();
    expect(() => transitionComplaint(resumed, { to: 'RESOLVED', at: '2026-01-01T06:00:00Z', actorRole: 'SUPERVISOR', note: 'Cleared' })).toThrow('photo');
    const resolved = transitionComplaint(resumed, { to: 'RESOLVED', at: '2026-01-01T06:00:00Z', actorRole: 'SUPERVISOR', note: 'Cleared', photoId: 'photo' }).complaint;
    expect(resolved.resolutionPhotoId).toBe('photo');
    expect(base.status).toBe('OPEN');
  });
  it('allows first reopen through seven days, escalates, retains original SLA and routes second reopen to ULB', () => {
    const resolved: ComplaintState = { ...base, status: 'RESOLVED', resolvedAt: '2026-01-01T06:00:00Z', resolutionNote: 'Fixed', resolutionPhotoId: 'p1' };
    const first = transitionComplaint(resolved, { to: 'REOPENED', at: '2026-01-08T06:00:00Z', actorRole: 'RESIDENT', note: 'Still not cleared' });
    expect(first.escalation).toBe('SUPERVISOR');
    expect(first.complaint).toMatchObject({ createdAt, reopenedCount: 1, status: 'REOPENED' });
    expect(first.complaint.resolvedAt).toBeUndefined();
    expect(calculateSla(first.complaint, '2026-01-08T06:00:00Z').breached).toBe(true);
    const again = transitionComplaint(first.complaint, { to: 'RESOLVED', at: '2026-01-08T07:00:00Z', actorRole: 'SUPERVISOR', note: 'Cleared again', photoId: 'p2' }).complaint;
    const second = transitionComplaint(again, { to: 'REOPENED', at: '2026-01-08T08:00:00Z', actorRole: 'RESIDENT', note: 'Still disputed' });
    expect(second.escalation).toBe('ULB_ADMIN');
    expect(second.complaint).toBe(again);
    expect(second.complaint.reopenedCount).toBe(1);
    expect(() => transitionComplaint(resolved, { to: 'REOPENED', at: '2026-01-08T06:00:00.001Z', actorRole: 'RESIDENT', note: 'Late' })).toThrow('seven days');
  });
  it('rejects invalid sequence, chronology and collector/resident resolution', () => {
    expect(() => transitionComplaint(base, { to: 'RESOLVED', at: createdAt, actorRole: 'SUPERVISOR', note: 'skip', photoId: 'p' })).toThrow('Cannot transition');
    expect(() => transitionComplaint(base, { to: 'ACKNOWLEDGED', at: createdAt, actorRole: 'COLLECTOR' })).toThrow('Actor');
    expect(() => transitionComplaint({ ...base, status: 'IN_PROGRESS' }, { to: 'RESOLVED', at: createdAt, actorRole: 'RESIDENT', note: 'fixed', photoId: 'p' })).toThrow('Actor');
    expect(() => transitionComplaint({ ...base, lastTransitionAt: '2026-01-01T02:00:00Z' }, { to: 'ACKNOWLEDGED', at: createdAt, actorRole: 'SUPERVISOR' })).toThrow('chronological');
  });
});
