import { describe, expect, it } from 'vitest';
import { assertInvoiceTransition, assertPickupTransition, assertStopTransition, ManualScaleAdapter, NoopContaminationScorer, ratingPermission, verifyPickup } from './index';
import { pickupFixture } from './fixtures.test-helper';

describe('auditable state transitions', () => {
  it('allows only the capture sequence and server verification result', () => {
    const collector = { actorRole: 'COLLECTOR' as const };
    expect(assertPickupTransition('SCHEDULED', 'IN_PROGRESS', collector)).toBe('IN_PROGRESS');
    expect(assertPickupTransition('IN_PROGRESS', 'CAPTURED', collector)).toBe('CAPTURED');
    expect(assertPickupTransition('CAPTURED', 'SYNCED', collector)).toBe('SYNCED');
    const { event, context } = pickupFixture();
    const verification = verifyPickup(event, context);
    expect(assertPickupTransition('SYNCED', 'VERIFIED', { ...collector, verification, hasException: false })).toBe('VERIFIED');
    expect(() => assertPickupTransition('SYNCED', 'VERIFIED', collector)).toThrow();
    expect(() => assertPickupTransition('SCHEDULED', 'VERIFIED', collector)).toThrow();
    expect(() => assertPickupTransition('VERIFIED', 'CAPTURED', collector)).toThrow();
  });
  it('requires a supervisor reason and corrected evidence for rejection; never verifies exceptions', () => {
    const { event, context } = pickupFixture();
    const verification = verifyPickup(event, { ...context, random: () => 0 });
    const supervisor = { actorRole: 'SUPERVISOR' as const, reason: 'Evidence checked', verification, hasException: false };
    expect(assertPickupTransition('NEEDS_REVIEW', 'VERIFIED', supervisor)).toBe('VERIFIED');
    expect(assertPickupTransition('REJECTED', 'CAPTURED', supervisor)).toBe('CAPTURED');
    expect(() => assertPickupTransition('REJECTED', 'VERIFIED', supervisor)).toThrow();
    expect(() => assertPickupTransition('NEEDS_REVIEW', 'VERIFIED', { ...supervisor, hasException: true })).toThrow('exception');
    expect(() => assertPickupTransition('NEEDS_REVIEW', 'VERIFIED', { ...supervisor, reason: '' })).toThrow('reason');
    expect(() => assertPickupTransition('NEEDS_REVIEW', 'REJECTED', { actorRole: 'COLLECTOR', reason: 'No' })).toThrow('Supervisor');
    const rejected = verifyPickup({ ...event, qrToken: 'bad' }, context);
    expect(() => assertPickupTransition('NEEDS_REVIEW', 'VERIFIED', { ...supervisor, verification: rejected })).toThrow('Hard failures');
    const exception = verifyPickup({ ...event, streams: [], exception: { code: 'WEIGHT_UNAVAILABLE', note: 'No scale', photoId: '66666666-6666-4666-8666-666666666666' } }, context);
    expect(() => assertPickupTransition('NEEDS_REVIEW', 'VERIFIED', { ...supervisor, verification: exception, hasException: false })).toThrow('exception');
  });
  it('requires a supervisor reason for skipping and does not reopen terminal stops/invoices', () => {
    expect(assertStopTransition('PENDING', 'DONE', { actorRole: 'COLLECTOR' })).toBe('DONE');
    expect(assertStopTransition('PENDING', 'EXCEPTION', { actorRole: 'COLLECTOR' })).toBe('EXCEPTION');
    expect(() => assertStopTransition('PENDING', 'SKIPPED', { actorRole: 'COLLECTOR', reason: 'Busy' })).toThrow();
    expect(assertStopTransition('PENDING', 'SKIPPED', { actorRole: 'SUPERVISOR', reason: 'Road closed' })).toBe('SKIPPED');
    expect(() => assertStopTransition('DONE', 'PENDING', { actorRole: 'SUPERVISOR' })).toThrow();
    expect(assertInvoiceTransition('DRAFT', 'ISSUED')).toBe('ISSUED');
    expect(assertInvoiceTransition('ISSUED', 'PAID')).toBe('PAID');
    expect(assertInvoiceTransition('DRAFT', 'VOID')).toBe('VOID');
    expect(() => assertInvoiceTransition('DRAFT', 'PAID')).toThrow();
    expect(() => assertInvoiceTransition('PAID', 'VOID')).toThrow();
  });
  it('enforces verified-only ratings and the exact 24-hour edit boundary', () => {
    expect(ratingPermission('VERIFIED', '2026-01-02T00:00:00Z')).toMatchObject({ allowed: true, mode: 'CREATE' });
    expect(ratingPermission('NEEDS_REVIEW', '2026-01-02T00:00:00Z').allowed).toBe(false);
    expect(ratingPermission('VERIFIED', '2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z')).toMatchObject({ allowed: true, mode: 'EDIT' });
    expect(ratingPermission('VERIFIED', '2026-01-02T00:00:00.001Z', '2026-01-01T00:00:00Z').allowed).toBe(false);
  });
});
describe('honest adapter seams', () => {
  it('manual scale requires weight and evidence, and never claims hardware verification', () => {
    const scale = new ManualScaleAdapter();
    expect(scale.read({ kg: 1.234, photoId: 'proof' })).toEqual({ kg: 1.234, photoId: 'proof', source: 'MANUAL', provenance: 'SELF_REPORTED' });
    expect(() => scale.read({ kg: 0, photoId: 'proof' })).toThrow();
    expect(() => scale.read({ kg: 1, photoId: '' })).toThrow();
    expect(new NoopContaminationScorer().score('proof')).toEqual({ status: 'NOT_MEASURED', score: null });
  });
});
