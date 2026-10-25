import type { Stream } from '@swachh/contracts';
import { STREAMS } from '@swachh/contracts';
import { billableMissedStops, verifiedStops, type OperationEvent, type ScheduledStop } from './operations';
import { integer, kgToGrams, nonnegative, sumKg } from './primitives';

export interface InvoiceRates {
  perFlatPaise: number;
  perVerifiedStopPaise?: number;
  handlingPaisePerKg?: Partial<Record<Stream, number>>;
  missedStopDeductionPaise?: number;
}
export interface InvoiceLine {
  type: 'SERVICE' | 'PICKUP' | 'HANDLING' | 'MISSED_DEDUCTION' | 'ADJUSTMENT';
  description: string;
  quantity: number;
  unit: 'FLAT' | 'STOP' | 'KG' | 'ADJUSTMENT';
  ratePaise: number;
  amountPaise: number;
  eventIds: string[];
  stopIds: string[];
  aggregateQueryRef?: string;
  stream?: Stream;
}
export interface InvoiceCalculationInput {
  activeFlats: number;
  activeFlatsQueryRef: string;
  stops: readonly ScheduledStop[];
  events: readonly OperationEvent[];
  rates: InvoiceRates;
  adjustments?: readonly { amountPaise: number; reason: string }[];
}
export interface InvoiceCalculation { currency: 'INR'; lines: InvoiceLine[]; subtotalPaise: number; deductionsPaise: number; totalPaise: number }

function safeMoney(value: bigint): number {
  const result = Number(value);
  return integer(result, 'paise amount');
}

export function calculateWeightChargePaise(kg: number, ratePaisePerKg: number): number {
  integer(nonnegative(ratePaisePerKg, 'rate'), 'rate');
  // One round per aggregated stream line, half-up to the nearest integer paise.
  return safeMoney((BigInt(kgToGrams(kg)) * BigInt(ratePaisePerKg) + 500n) / 1000n);
}

export function calculateInvoice(input: InvoiceCalculationInput): InvoiceCalculation {
  integer(nonnegative(input.activeFlats, 'active flats'), 'active flats');
  if (!input.activeFlatsQueryRef.trim()) throw new Error('Active-flat count requires an auditable query reference');
  const rates = input.rates;
  for (const rate of [rates.perFlatPaise, rates.perVerifiedStopPaise ?? 0, rates.missedStopDeductionPaise ?? 0, ...Object.values(rates.handlingPaisePerKg ?? {})]) integer(nonnegative(rate, 'rate'), 'rate');
  const selected = verifiedStops(input.stops, input.events);
  const lines: InvoiceLine[] = [{
    type: 'SERVICE', description: 'Per-flat service fee', quantity: input.activeFlats, unit: 'FLAT', ratePaise: rates.perFlatPaise,
    amountPaise: safeMoney(BigInt(input.activeFlats) * BigInt(rates.perFlatPaise)), eventIds: [], stopIds: [], aggregateQueryRef: input.activeFlatsQueryRef,
  }];
  if (rates.perVerifiedStopPaise !== undefined) lines.push({
    type: 'PICKUP', description: 'Verified pickup stops', quantity: selected.length, unit: 'STOP', ratePaise: rates.perVerifiedStopPaise,
    amountPaise: safeMoney(BigInt(selected.length) * BigInt(rates.perVerifiedStopPaise)), eventIds: selected.map(item => item.event.id), stopIds: selected.map(item => item.stop.id),
  });
  for (const stream of STREAMS) {
    const rate = rates.handlingPaisePerKg?.[stream];
    if (rate === undefined) continue;
    const contributors = selected.filter(item => item.event.streams.some(entry => entry.stream === stream));
    const kg = sumKg(contributors.flatMap(item => item.event.streams.filter(entry => entry.stream === stream).map(entry => entry.kg)));
    lines.push({ type: 'HANDLING', stream, description: `${stream} handling`, quantity: kg, unit: 'KG', ratePaise: rate, amountPaise: calculateWeightChargePaise(kg, rate), eventIds: contributors.map(item => item.event.id), stopIds: contributors.map(item => item.stop.id) });
  }
  if (rates.missedStopDeductionPaise !== undefined) {
    const missed = billableMissedStops(input.stops, input.events);
    const stopIds = missed.map(stop => stop.id);
    lines.push({ type: 'MISSED_DEDUCTION', description: 'Stops without a verified pickup or accepted exception', quantity: missed.length, unit: 'STOP', ratePaise: rates.missedStopDeductionPaise, amountPaise: -safeMoney(BigInt(missed.length) * BigInt(rates.missedStopDeductionPaise)), stopIds, eventIds: input.events.filter(event => stopIds.includes(event.routeStopId)).map(event => event.id) });
  }
  for (const adjustment of input.adjustments ?? []) {
    integer(adjustment.amountPaise, 'adjustment paise');
    if (!adjustment.reason.trim()) throw new Error('Manual adjustment requires a reason');
    lines.push({ type: 'ADJUSTMENT', description: adjustment.reason, quantity: 1, unit: 'ADJUSTMENT', ratePaise: adjustment.amountPaise, amountPaise: adjustment.amountPaise, eventIds: [], stopIds: [] });
  }
  const subtotalPaise = safeMoney(lines.reduce((sum, line) => sum + BigInt(Math.max(0, line.amountPaise)), 0n));
  const deductionsPaise = safeMoney(lines.reduce((sum, line) => sum + BigInt(Math.max(0, -line.amountPaise)), 0n));
  const totalPaise = safeMoney(BigInt(subtotalPaise) - BigInt(deductionsPaise));
  if (totalPaise < 0) throw new RangeError('Invoice cannot have a negative payable total; issue a separate credit');
  return { currency: 'INR', lines, subtotalPaise, deductionsPaise, totalPaise };
}
