import { createHash } from 'node:crypto';

// Keep seed identifiers independent of seed-data's storage and image dependencies.
export function demoId(label: string) {
  const hex = createHash('sha256').update(`swachh-track-fictional:${label}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export const DEMO_ULB_ID = demoId('ulb-nagar');
export const DEMO_ULB_CODE = 'NAGAR-DEMO';
export const DEMO_SEED_ACTION = 'FICTIONAL_DEMO_SEEDED';
export const DEMO_USERS = ([
  { alias: 'resident', phone: '+919000000001', name: 'Demo Resident', role: 'RESIDENT' },
  { alias: 'society', phone: '+919000000002', name: 'Demo Society Administrator', role: 'SOCIETY_ADMIN' },
  { alias: 'collector', phone: '+919000000003', name: 'Demo Collector One', role: 'COLLECTOR' },
  { alias: 'supervisor', phone: '+919000000004', name: 'Demo Supervisor', role: 'SUPERVISOR' },
  { alias: 'ulb', phone: '+919000000005', name: 'Demo Municipal Officer', role: 'ULB_ADMIN' },
] as const).map(account => ({
  ...account,
  id: demoId(`user-${account.alias}`),
  email: `${account.alias}@demo.swachhtrack.in`,
  membershipId: demoId(`membership-${account.alias}`),
  societyId: ['RESIDENT', 'SOCIETY_ADMIN'].includes(account.role) ? demoId('society-0') : null,
  contractorId: ['COLLECTOR', 'SUPERVISOR'].includes(account.role) ? demoId('contractor-0') : null,
}));
