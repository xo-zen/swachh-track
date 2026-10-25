import type { InvoiceStatus, PickupStatus, Role, StopStatus, VerificationStatus } from '@swachh/contracts';
import type { VerificationResult } from './verification';
import { DAY_MS, timestamp } from './primitives';

export interface TransitionAuthority { actorRole: Role; reason?: string }
const supervisors: readonly Role[] = ['SUPERVISOR', 'ULB_ADMIN', 'SUPER_ADMIN'];
const pickupTransitions: Record<PickupStatus, readonly PickupStatus[]> = {
  SCHEDULED: ['IN_PROGRESS'], IN_PROGRESS: ['CAPTURED'], CAPTURED: ['SYNCED'],
  SYNCED: ['VERIFIED', 'NEEDS_REVIEW', 'REJECTED'], NEEDS_REVIEW: ['VERIFIED', 'REJECTED'],
  REJECTED: ['CAPTURED'], VERIFIED: [],
};
export function assertPickupTransition(from: PickupStatus, to: PickupStatus, authority: TransitionAuthority & { verification?: VerificationResult; hasException?: boolean }): PickupStatus {
  if (!pickupTransitions[from].includes(to)) throw new Error(`Cannot transition pickup ${from} -> ${to}`);
  if (from === 'SYNCED' && authority.verification?.status !== to) throw new Error('Server verification result must match the target status');
  if (from === 'NEEDS_REVIEW' || from === 'REJECTED') {
    if (!supervisors.includes(authority.actorRole) || !authority.reason?.trim()) throw new Error('Supervisor action requires a reason');
  }
  if (to === 'VERIFIED') {
    if (authority.hasException !== false || authority.verification?.reasons.some(reason => reason.code === 'EXCEPTION_RECORDED')) throw new Error('A pickup with an exception cannot be verified');
    if (!authority.verification || authority.verification.status === 'REJECTED' || authority.verification.reasons.some(reason => reason.severity === 'HARD')) throw new Error('Hard failures require corrected evidence and re-verification');
  }
  return to;
}
export function assertStopTransition(from: StopStatus, to: StopStatus, authority: TransitionAuthority): StopStatus {
  if (from !== 'PENDING' || to === 'PENDING') throw new Error(`Cannot transition stop ${from} -> ${to}`);
  if (to === 'SKIPPED' && (!supervisors.includes(authority.actorRole) || !authority.reason?.trim())) throw new Error('Skipping requires a supervisor reason');
  return to;
}
export function assertInvoiceTransition(from: InvoiceStatus, to: InvoiceStatus): InvoiceStatus {
  const transitions: Record<InvoiceStatus, readonly InvoiceStatus[]> = { DRAFT: ['ISSUED', 'VOID'], ISSUED: ['PAID', 'VOID'], PAID: [], VOID: [] };
  if (!transitions[from].includes(to)) throw new Error(`Cannot transition invoice ${from} -> ${to}`);
  return to;
}
export function ratingPermission(status: VerificationStatus, now: string, existingCreatedAt?: string): { allowed: boolean; mode: 'CREATE' | 'EDIT'; reason: string } {
  const at = timestamp(now);
  const mode = existingCreatedAt ? 'EDIT' as const : 'CREATE' as const;
  if (status !== 'VERIFIED') return { allowed: false, mode, reason: 'Only verified pickups can be rated' };
  if (existingCreatedAt) {
    const age = at - timestamp(existingCreatedAt);
    if (age < 0 || age > DAY_MS) return { allowed: false, mode, reason: 'Ratings can be edited for 24 hours after creation' };
  }
  return { allowed: true, mode, reason: existingCreatedAt ? 'Update the existing resident/pickup rating; do not insert another' : 'One rating per resident per pickup' };
}
