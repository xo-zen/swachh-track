import { describe, expect, it } from 'vitest';
import { calculateCertificateCoverage, calculateEligibility, calculateMassBalance, canAssignVendor, certificateExpiryAlert, certificateValidUntil, estimateAnnualObligation, type CertificateRecord, type WasteMeasurement } from './index';
import { operationFixture, streamFixture } from './fixtures.test-helper';

const eligibility = { floorAreaSqm: 0, waterLitresPerDay: 0, wasteKgPerDay: 0, flats: 1, isRwaOrGatedCommunity: true };
const measurement = (kg: number, provenance: WasteMeasurement['provenance'] = 'VERIFIED'): WasteMeasurement => ({ kg, provenance, sourceIds: ['evidence-query'] });
const certificate: CertificateRecord = { id: 'c1', societyId: 'society-a', issuingUlbId: 'ulb-a', documentId: 'doc-a', stream: 'WET', kg: 120, issuedAt: '2025-01-01', status: 'ACTIVE' };

describe('eligibility thresholds', () => {
  it.each([
    [5000, 'BELOW_THRESHOLD'], [5000.001, 'RWA_DUTIES_ONLY'], [19999.999, 'RWA_DUTIES_ONLY'], [20000, 'BWG'],
  ] as const)('handles area %s as %s', (floorAreaSqm, classification) => {
    expect(calculateEligibility({ ...eligibility, floorAreaSqm }).classification).toBe(classification);
  });
  it('uses inclusive independent water and waste thresholds and no flat-count threshold', () => {
    expect(calculateEligibility({ ...eligibility, waterLitresPerDay: 39999.999 }).classification).toBe('BELOW_THRESHOLD');
    expect(calculateEligibility({ ...eligibility, waterLitresPerDay: 40000 }).classification).toBe('BWG');
    expect(calculateEligibility({ ...eligibility, wasteKgPerDay: 99.999 }).classification).toBe('BELOW_THRESHOLD');
    expect(calculateEligibility({ ...eligibility, wasteKgPerDay: 100 }).classification).toBe('BWG');
    expect(calculateEligibility({ ...eligibility, flats: 10000 }).classification).toBe('BELOW_THRESHOLD');
    expect(calculateEligibility({ ...eligibility, floorAreaSqm: 6000, isRwaOrGatedCommunity: false }).classification).toBe('BELOW_THRESHOLD');
    expect(calculateEligibility({ ...eligibility, wasteKgPerDay: 100 }).disclaimer).toContain('ULB');
    expect(() => calculateEligibility({ ...eligibility, wasteKgPerDay: NaN })).toThrow();
  });
});

describe('mass balance and measured recycling', () => {
  it('has strict above-5% review threshold and exact gram differences', () => {
    const exact = calculateMassBalance({ collected: measurement(100), handedOver: measurement(95), processed: measurement(95), verifiedRegisteredProcessorReceipt: true });
    expect(exact).toMatchObject({ handoverGapKg: 5, processingGapKg: 0, variancePct: 5, requiresReview: false });
    expect(exact.recyclingRate).toMatchObject({ value: 95, provenance: 'VERIFIED' });
    expect(calculateMassBalance({ collected: measurement(100), handedOver: measurement(94.999), processed: measurement(94.999), verifiedRegisteredProcessorReceipt: true }).requiresReview).toBe(true);
    expect(calculateMassBalance({ collected: measurement(0.3), handedOver: measurement(0.2), processed: measurement(0.1), verifiedRegisteredProcessorReceipt: true }).handoverGapKg).toBe(0.1);
  });
  it('detects excess handover, processing imbalance, zero-denominator anomalies and configurable tolerance', () => {
    expect(calculateMassBalance({ collected: measurement(100), handedOver: measurement(110), processed: measurement(100), verifiedRegisteredProcessorReceipt: true })).toMatchObject({ requiresReview: true, recyclingRate: { value: null } });
    expect(calculateMassBalance({ collected: measurement(100), handedOver: measurement(100), processed: measurement(90), verifiedRegisteredProcessorReceipt: true }).processingVariancePct).toBe(10);
    expect(calculateMassBalance({ collected: measurement(0), handedOver: measurement(1), processed: measurement(0), verifiedRegisteredProcessorReceipt: true })).toMatchObject({ variancePct: null, requiresReview: true });
    expect(calculateMassBalance({ collected: measurement(100), handedOver: measurement(90), processed: measurement(90), verifiedRegisteredProcessorReceipt: false, tolerancePct: 10 }).requiresReview).toBe(false);
  });
  it('never reports recycling without verified processor evidence and keeps quantity provenance separate', () => {
    for (const provenance of ['SELF_REPORTED', 'ESTIMATED'] as const) {
      const result = calculateMassBalance({ collected: measurement(100), handedOver: measurement(100), processed: measurement(90, provenance), verifiedRegisteredProcessorReceipt: true });
      expect(result.processed.provenance).toBe(provenance);
      expect(result.recyclingRate).toMatchObject({ value: null, provenance: 'NOT_MEASURED' });
    }
    expect(calculateMassBalance({ collected: measurement(100), handedOver: measurement(100), processed: measurement(90), verifiedRegisteredProcessorReceipt: false }).recyclingRate.value).toBeNull();
    expect(() => calculateMassBalance({ collected: { ...measurement(100), sourceIds: [] }, handedOver: measurement(100), processed: measurement(90), verifiedRegisteredProcessorReceipt: true })).toThrow('provenance');
  });
});

describe('certificate reconciliation', () => {
  it('defaults to three calendar years and clamps leap day; expiry day is inclusive', () => {
    expect(certificateValidUntil('2024-02-29')).toBe('2027-02-28');
    expect(certificateValidUntil('2024-02-29', 4)).toBe('2028-02-29');
    expect(() => certificateValidUntil('2025-02-29')).toThrow();
    expect(() => certificateValidUntil('2024-01-01', 0)).toThrow();
    expect(certificateExpiryAlert('2026-04-01', '2026-01-01')).toBe(90);
    expect(certificateExpiryAlert('2026-01-31', '2026-01-01')).toBe(30);
    expect(certificateExpiryAlert('2026-01-08', '2026-01-01')).toBe(7);
    expect(certificateExpiryAlert('2026-01-01', '2026-01-01')).toBe(7);
    expect(certificateExpiryAlert('2025-12-31', '2026-01-01')).toBe('EXPIRED');
    expect(certificateExpiryAlert('2027-01-01', '2026-01-01')).toBeNull();
  });
  it('counts only documented active in-date certificates in this society and never offsets stream gaps', () => {
    const result = calculateCertificateCoverage({
      societyId: 'society-a', asOf: '2026-01-15', requiredKg: { WET: 100, DRY: 100, SANITARY: 0, SPECIAL_CARE: 0 }, obligationProvenance: 'ESTIMATED', obligationSourceIds: ['pickup-history'],
      certificates: [certificate,
        { ...certificate, id: 'dry', stream: 'DRY', kg: 40, validUntil: '2026-01-15' },
        { ...certificate, id: 'expired', validUntil: '2026-01-14' },
        { ...certificate, id: 'future', issuedAt: '2026-01-16' },
        { ...certificate, id: 'revoked', status: 'REVOKED' },
        { ...certificate, id: 'foreign', societyId: 'society-b' },
        { ...certificate, id: 'undocumented', documentId: '' },
        { ...certificate, id: 'not-issued-by-ulb', issuingUlbId: '' },
      ],
    });
    expect(result).toMatchObject({ requiredKg: 200, heldKg: 160, coveragePct: 80, gapKg: 60, provenance: 'ESTIMATED', heldProvenance: 'VERIFIED' });
    expect(result.byStream.WET).toMatchObject({ coveragePct: 120, gapKg: 0, certificateIds: ['c1'] });
    expect(result.byStream.DRY).toMatchObject({ coveragePct: 40, gapKg: 60, certificateIds: ['dry'] });
    expect(result.byStream.SANITARY.coveragePct).toBeNull();
  });
  it('returns not measured for no obligation and rejects double-counted certificates', () => {
    const input = { societyId: 'society-a', asOf: '2026-01-15', requiredKg: { WET: 0, DRY: 0, SANITARY: 0, SPECIAL_CARE: 0 }, obligationProvenance: 'ESTIMATED' as const, obligationSourceIds: ['query'], certificates: [] };
    expect(calculateCertificateCoverage(input).coveragePct).toBeNull();
    expect(() => calculateCertificateCoverage({ ...input, certificates: [certificate, certificate] })).toThrow('Duplicate');
  });
  it('annualises only verified history and labels estimates, with optional wet exemption', () => {
    const events = [operationFixture({ streams: [streamFixture({ kg: 10 }), streamFixture({ stream: 'DRY', kg: 5 })] }), operationFixture({ id: 'bad', status: 'REJECTED', streams: [streamFixture({ kg: 1000 })] })];
    const result = estimateAnnualObligation(events, 10, 365, 2);
    expect(result.WET).toEqual({ annualKg: 365, requiredKg: 292, provenance: 'ESTIMATED', sourceIds: ['e1'] });
    expect(result.DRY.requiredKg).toBe(182.5);
    expect(() => estimateAnnualObligation(events, 0)).toThrow();
  });
  it('blocks expired, not-yet-valid, undocumented and inactive vendors', () => {
    const vendor = { validFrom: '2026-01-01', validUntil: '2026-01-15', documentId: 'd1', active: true };
    expect(canAssignVendor(vendor, '2026-01-15')).toBe(true);
    expect(canAssignVendor(vendor, '2026-01-16')).toBe(false);
    expect(canAssignVendor(vendor, '2025-12-31')).toBe(false);
    expect(canAssignVendor({ ...vendor, documentId: '' }, '2026-01-15')).toBe(false);
    expect(canAssignVendor({ ...vendor, active: false }, '2026-01-15')).toBe(false);
  });
});
