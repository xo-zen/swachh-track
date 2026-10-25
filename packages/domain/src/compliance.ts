import { STREAMS, type EligibilityInput, type Provenance, type Stream } from '@swachh/contracts';
import { DAY_MS, calendarDay, integer, kgToGrams, nonnegative, sumKg } from './primitives';
import type { OperationEvent } from './operations';

export interface EligibilityResult {
  classification: 'BWG' | 'RWA_DUTIES_ONLY' | 'BELOW_THRESHOLD';
  rwaDuties: boolean;
  reasons: string[];
  disclaimer: string;
}
export function calculateEligibility(input: EligibilityInput): EligibilityResult {
  for (const value of [input.floorAreaSqm, input.waterLitresPerDay, input.wasteKgPerDay]) nonnegative(value, 'Eligibility input');
  integer(nonnegative(input.flats, 'flats'), 'flats');
  const reasons: string[] = [];
  if (input.floorAreaSqm >= 20_000) reasons.push('Floor area is at least 20,000 sq m');
  if (input.waterLitresPerDay >= 40_000) reasons.push('Water use is at least 40,000 litres/day');
  if (input.wasteKgPerDay >= 100) reasons.push('Waste generation is at least 100 kg/day');
  const bwg = reasons.length > 0;
  const rwaDuties = input.isRwaOrGatedCommunity && input.floorAreaSqm > 5000;
  if (rwaDuties) reasons.push('RWA/gated community area is above 5,000 sq m');
  if (!reasons.length) reasons.push('No configured threshold met');
  return { classification: bwg ? 'BWG' : rwaDuties ? 'RWA_DUTIES_ONLY' : 'BELOW_THRESHOLD', rwaDuties, reasons, disclaimer: 'Indicative eligibility only. The ULB makes the final determination.' };
}

export interface WasteMeasurement {
  kg: number;
  provenance: Exclude<Provenance, 'NOT_MEASURED'>;
  sourceIds: readonly string[];
}
export interface MassBalanceInput {
  collected: WasteMeasurement;
  handedOver: WasteMeasurement;
  processed: WasteMeasurement;
  verifiedRegisteredProcessorReceipt: boolean;
  tolerancePct?: number;
}
export function calculateMassBalance(input: MassBalanceInput) {
  for (const measurement of [input.collected, input.handedOver, input.processed]) {
    kgToGrams(measurement.kg);
    if (!measurement.sourceIds.length) throw new Error('Every quantity requires provenance source IDs or a query reference');
  }
  const tolerancePct = nonnegative(input.tolerancePct ?? 5, 'Tolerance');
  const collectedGrams = kgToGrams(input.collected.kg);
  const handoverGrams = kgToGrams(input.handedOver.kg);
  const processedGrams = kgToGrams(input.processed.kg);
  const variance = (numerator: number, denominator: number): number | null => denominator === 0 ? null : Math.abs(numerator) / denominator * 100;
  const handoverVariancePct = variance(collectedGrams - handoverGrams, collectedGrams);
  const processingVariancePct = variance(handoverGrams - processedGrams, handoverGrams);
  const variancePct = variance(collectedGrams - processedGrams, collectedGrams);
  const requiresReview = [handoverVariancePct, processingVariancePct, variancePct].some(value => value !== null && value > tolerancePct)
    || (collectedGrams === 0 && handoverGrams > 0) || (handoverGrams === 0 && processedGrams > 0);
  const measured = input.verifiedRegisteredProcessorReceipt && input.handedOver.provenance === 'VERIFIED' && input.processed.provenance === 'VERIFIED' && input.collected.provenance === 'VERIFIED' && collectedGrams > 0 && handoverGrams > 0 && processedGrams <= handoverGrams && handoverGrams <= collectedGrams;
  return {
    collected: input.collected, handedOver: input.handedOver, processed: input.processed,
    handoverGapKg: (collectedGrams - handoverGrams) / 1000,
    processingGapKg: (handoverGrams - processedGrams) / 1000,
    handoverVariancePct, processingVariancePct, variancePct, requiresReview,
    recyclingRate: {
      value: measured ? processedGrams / collectedGrams * 100 : null,
      unit: '%', provenance: measured ? 'VERIFIED' as const : 'NOT_MEASURED' as const,
      definition: 'Verified processed/recycled kg / verified collected kg x 100; requires verified handover to a registered processor/recycler and receipt evidence.',
      sourceIds: measured ? [...input.collected.sourceIds, ...input.handedOver.sourceIds, ...input.processed.sourceIds] : [],
    },
  };
}

export interface CertificateRecord {
  id: string;
  societyId: string;
  issuingUlbId: string;
  documentId: string;
  stream: Stream;
  kg: number;
  issuedAt: string;
  validUntil?: string;
  status: 'ACTIVE' | 'REVOKED';
}
export function certificateValidUntil(issuedAt: string, validityYears = 3): string {
  const date = new Date(calendarDay(issuedAt));
  integer(validityYears, 'Validity years');
  if (validityYears < 1 || validityYears > 100) throw new RangeError('Validity must be 1 to 100 years');
  const year = date.getUTCFullYear() + validityYears;
  const month = date.getUTCMonth();
  const day = Math.min(date.getUTCDate(), new Date(Date.UTC(year, month + 1, 0)).getUTCDate());
  return new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
}
export function certificateExpiryAlert(validUntil: string, asOf: string): 90 | 30 | 7 | 'EXPIRED' | null {
  const days = (calendarDay(validUntil) - calendarDay(asOf)) / DAY_MS;
  return days < 0 ? 'EXPIRED' : days <= 7 ? 7 : days <= 30 ? 30 : days <= 90 ? 90 : null;
}
export function canAssignVendor(vendor: { validFrom: string; validUntil: string; documentId: string; active: boolean }, onDate: string): boolean {
  const now = calendarDay(onDate);
  const start = calendarDay(vendor.validFrom);
  const end = calendarDay(vendor.validUntil);
  return vendor.active && Boolean(vendor.documentId.trim()) && start <= now && now <= end;
}

export function estimateAnnualObligation(events: readonly OperationEvent[], observedDays: number, yearDays = 365, verifiedOnsiteWetKg = 0) {
  integer(observedDays, 'Observed days');
  integer(yearDays, 'Year days');
  if (observedDays < 1 || yearDays < 1 || observedDays > yearDays) throw new RangeError('Observed days must be within the year');
  kgToGrams(verifiedOnsiteWetKg);
  if (new Set(events.map(event => event.id)).size !== events.length) throw new Error('Duplicate event ID');
  const verified = events.filter(event => event.status === 'VERIFIED' && !event.exception);
  const result = {} as Record<Stream, { requiredKg: number; annualKg: number; provenance: 'ESTIMATED'; sourceIds: string[] }>;
  for (const stream of STREAMS) {
    const contributors = verified.filter(event => event.streams.some(entry => entry.stream === stream));
    const collected = sumKg(contributors.flatMap(event => event.streams.filter(entry => entry.stream === stream).map(entry => entry.kg)));
    const annualGrams = Math.ceil(kgToGrams(collected) * yearDays / observedDays);
    const exemptionGrams = stream === 'WET' ? Math.floor(kgToGrams(verifiedOnsiteWetKg) * yearDays / observedDays) : 0;
    result[stream] = { requiredKg: Math.max(0, annualGrams - exemptionGrams) / 1000, annualKg: annualGrams / 1000, provenance: 'ESTIMATED', sourceIds: contributors.map(event => event.id) };
  }
  return result;
}

export interface CertificateCoverageInput {
  societyId: string;
  asOf: string;
  requiredKg: Record<Stream, number>;
  obligationProvenance: Exclude<Provenance, 'NOT_MEASURED'>;
  obligationSourceIds: readonly string[];
  certificates: readonly CertificateRecord[];
  validityYears?: number;
}
export function calculateCertificateCoverage(input: CertificateCoverageInput) {
  const now = calendarDay(input.asOf);
  if (!input.obligationSourceIds.length) throw new Error('Certificate obligations require provenance source IDs or a query reference');
  if (new Set(input.certificates.map(certificate => certificate.id)).size !== input.certificates.length) throw new Error('Duplicate certificate ID');
  const valid = input.certificates.filter(certificate => {
    kgToGrams(certificate.kg);
    const issued = calendarDay(certificate.issuedAt);
    const expires = calendarDay(certificate.validUntil ?? certificateValidUntil(certificate.issuedAt, input.validityYears));
    return certificate.societyId === input.societyId && certificate.status === 'ACTIVE' && Boolean(certificate.issuingUlbId.trim()) && Boolean(certificate.documentId.trim()) && issued <= now && now <= expires;
  });
  const byStream = {} as Record<Stream, { requiredKg: number; heldKg: number; coveragePct: number | null; gapKg: number; certificateIds: string[] }>;
  for (const stream of STREAMS) {
    const requiredGrams = kgToGrams(input.requiredKg[stream]);
    const certificates = valid.filter(certificate => certificate.stream === stream);
    const heldKg = sumKg(certificates.map(certificate => certificate.kg));
    byStream[stream] = { requiredKg: requiredGrams / 1000, heldKg, coveragePct: requiredGrams > 0 ? kgToGrams(heldKg) / requiredGrams * 100 : null, gapKg: Math.max(0, requiredGrams - kgToGrams(heldKg)) / 1000, certificateIds: certificates.map(certificate => certificate.id) };
  }
  const requiredKg = sumKg(STREAMS.map(stream => byStream[stream].requiredKg));
  const heldKg = sumKg(STREAMS.map(stream => byStream[stream].heldKg));
  return {
    byStream, requiredKg, heldKg,
    coveragePct: requiredKg > 0 ? heldKg / requiredKg * 100 : null,
    gapKg: sumKg(STREAMS.map(stream => byStream[stream].gapKg)),
    provenance: input.obligationProvenance,
    heldProvenance: 'VERIFIED' as const,
    obligationSourceIds: input.obligationSourceIds,
    definition: 'Valid, documented ULB certificate kg / calculated obligation kg x 100. Surplus in one stream does not offset another stream\'s gap.',
  };
}
