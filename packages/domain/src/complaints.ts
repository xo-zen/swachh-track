import type { ComplaintStatus, Role } from '@swachh/contracts';
import { DAY_MS, integer, nonnegative, timestamp } from './primitives';

export interface SlaPause { startedAt: string; endedAt?: string; reason: string }
export interface SlaInput { createdAt: string; slaHours: number; pauses: readonly SlaPause[]; resolvedAt?: string }
export interface SlaResult { dueAt: string; elapsedMs: number; remainingMs: number; pausedMs: number; paused: boolean; breached: boolean; resolved: boolean }

export function calculateSla(input: SlaInput, now: string): SlaResult {
  const created = timestamp(input.createdAt);
  const current = timestamp(now);
  const end = input.resolvedAt ? timestamp(input.resolvedAt) : current;
  const budget = nonnegative(input.slaHours, 'SLA hours') * 3_600_000;
  if (budget === 0 || !Number.isSafeInteger(budget)) throw new RangeError('SLA must be positive and represent whole milliseconds');
  if (end < created || current < end) throw new RangeError('Invalid SLA timeline');
  let previousEnd = created;
  let pausedMs = 0;
  let paused = false;
  for (const [index, pause] of input.pauses.entries()) {
    if (!pause.reason.trim()) throw new Error('Only WAITING_FOR_RESIDENT with a reason can pause SLA');
    const start = timestamp(pause.startedAt);
    const stop = pause.endedAt ? timestamp(pause.endedAt) : end;
    if (start < previousEnd || stop < start || stop > end || start > end || (!pause.endedAt && index !== input.pauses.length - 1)) throw new RangeError('SLA pauses must be ordered, disjoint and inside the lifecycle');
    if (!pause.endedAt && input.resolvedAt) throw new Error('Close the resident-wait pause before resolving');
    pausedMs += stop - start;
    previousEnd = stop;
    paused = !pause.endedAt;
  }
  const elapsedMs = end - created - pausedMs;
  return { dueAt: new Date(created + budget + pausedMs).toISOString(), elapsedMs, remainingMs: Math.max(0, budget - elapsedMs), pausedMs, paused, breached: elapsedMs > budget, resolved: Boolean(input.resolvedAt) };
}

export interface ComplaintState extends SlaInput {
  status: ComplaintStatus;
  reopenedCount: number;
  waitingFrom?: 'ACKNOWLEDGED' | 'IN_PROGRESS' | 'REOPENED';
  resolutionNote?: string;
  resolutionPhotoId?: string;
  lastTransitionAt?: string;
}
export interface ComplaintTransition { to: ComplaintStatus; at: string; actorRole: Role; note?: string; photoId?: string }
export interface ComplaintTransitionResult { complaint: ComplaintState; escalation: 'SUPERVISOR' | 'ULB_ADMIN' | null }
const transitions: Record<ComplaintStatus, readonly ComplaintStatus[]> = {
  OPEN: ['ACKNOWLEDGED'], ACKNOWLEDGED: ['IN_PROGRESS', 'WAITING_FOR_RESIDENT'],
  IN_PROGRESS: ['RESOLVED', 'WAITING_FOR_RESIDENT'], WAITING_FOR_RESIDENT: ['ACKNOWLEDGED', 'IN_PROGRESS', 'REOPENED'],
  RESOLVED: ['CLOSED', 'REOPENED'], CLOSED: [], REOPENED: ['IN_PROGRESS', 'WAITING_FOR_RESIDENT', 'RESOLVED'],
};
const resolverRoles: readonly Role[] = ['SOCIETY_ADMIN', 'SUPERVISOR', 'ULB_ADMIN', 'SUPER_ADMIN'];

export function transitionComplaint(state: ComplaintState, action: ComplaintTransition): ComplaintTransitionResult {
  const now = timestamp(action.at);
  integer(nonnegative(state.reopenedCount, 'Reopen count'), 'Reopen count');
  if (now < timestamp(state.lastTransitionAt ?? state.createdAt)) throw new RangeError('Complaint transitions must be chronological');
  calculateSla(state, action.at);
  if (!transitions[state.status].includes(action.to)) throw new Error(`Cannot transition complaint ${state.status} -> ${action.to}`);
  if (action.to === 'REOPENED' && state.status === 'RESOLVED') {
    if (action.actorRole !== 'RESIDENT' && !resolverRoles.includes(action.actorRole)) throw new Error('Actor cannot reopen complaints');
    if (!action.note?.trim()) throw new Error('Reopen requires a reason');
    if (!state.resolvedAt || now < timestamp(state.resolvedAt) || now - timestamp(state.resolvedAt) > 7 * DAY_MS) throw new Error('Reopen window is seven days after resolution');
    if (state.reopenedCount >= 1) return { complaint: state, escalation: 'ULB_ADMIN' };
    const reopened = { ...state, status: 'REOPENED' as const, reopenedCount: 1, lastTransitionAt: action.at };
    delete reopened.resolvedAt;
    delete reopened.resolutionNote;
    delete reopened.resolutionPhotoId;
    return { complaint: reopened, escalation: 'SUPERVISOR' };
  }
  if (!(action.to === 'CLOSED' && action.actorRole === 'RESIDENT') && !resolverRoles.includes(action.actorRole)) throw new Error('Actor cannot resolve or manage complaints');
  const next: ComplaintState = { ...state, status: action.to, lastTransitionAt: action.at, pauses: state.pauses.map(pause => ({ ...pause })) };
  if (action.to === 'WAITING_FOR_RESIDENT') {
    if (!action.note?.trim()) throw new Error('Resident wait requires a reason');
    if (state.status !== 'ACKNOWLEDGED' && state.status !== 'IN_PROGRESS' && state.status !== 'REOPENED') throw new Error('Cannot pause this status');
    next.waitingFrom = state.status;
    next.pauses = [...state.pauses, { startedAt: action.at, reason: action.note }];
  }
  if (state.status === 'WAITING_FOR_RESIDENT') {
    if (action.to !== state.waitingFrom) throw new Error('Resume the status that was paused');
    const last = next.pauses[next.pauses.length - 1];
    if (!last || last.endedAt) throw new Error('No active resident-wait pause');
    next.pauses = [...next.pauses.slice(0, -1), { ...last, endedAt: action.at }];
    delete next.waitingFrom;
  }
  if (action.to === 'RESOLVED') {
    if (!action.note?.trim() || !action.photoId?.trim()) throw new Error('Resolution requires a note and photo');
    next.resolvedAt = action.at;
    next.resolutionNote = action.note;
    next.resolutionPhotoId = action.photoId;
  }
  return { complaint: next, escalation: null };
}

export function slaEscalation(sla: SlaResult, now: string, supervisorNotifiedAt?: string, ulbDelayMs = 3_600_000): 'SUPERVISOR' | 'ULB_ADMIN' | null {
  nonnegative(ulbDelayMs, 'ULB escalation delay');
  const at = timestamp(now);
  if (!sla.breached || sla.resolved) return null;
  if (!supervisorNotifiedAt) return 'SUPERVISOR';
  const notified = timestamp(supervisorNotifiedAt);
  if (notified > at) throw new RangeError('Supervisor notification is in the future');
  return at - notified >= ulbDelayMs ? 'ULB_ADMIN' : null;
}
