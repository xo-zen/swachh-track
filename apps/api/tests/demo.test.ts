import { describe, expect, it } from 'vitest';
import { demoId, DEMO_SEED_ACTION, DEMO_ULB_CODE, DEMO_ULB_ID, DEMO_USERS } from '../src/demo.js';

describe('lightweight demo identity constants', () => {
  it('preserves the existing seed SHA256 UUID algorithm', () => {
    expect(demoId('ulb-nagar')).toBe('df384f85-c614-4aeb-ab5d-6e5e941797be');
    expect(DEMO_ULB_ID).toBe(demoId('ulb-nagar'));
    expect(DEMO_ULB_CODE).toBe('NAGAR-DEMO');
    expect(DEMO_SEED_ACTION).toBe('FICTIONAL_DEMO_SEEDED');
    expect(DEMO_USERS.map(user => user.id)).toEqual([
      '9e5cfc46-3df5-4672-a489-b273ba315db7', '10eef9bd-283e-4432-ad9e-a7d6739bae3a',
      'f30f91a1-b843-475a-ad37-6992db93e549', 'fb1fda61-2e38-4f6f-a37f-89098b6c571c',
      '4ff88dd7-2893-4224-ae7a-956dd90f3190',
    ]);
  });
  it('includes only the five primary fictional identities and their original membership bindings', () => {
    expect(DEMO_USERS.map(user => [user.phone, user.email])).toEqual([
      ['+919000000001', 'resident@demo.swachhtrack.in'],
      ['+919000000002', 'society@demo.swachhtrack.in'],
      ['+919000000003', 'collector@demo.swachhtrack.in'],
      ['+919000000004', 'supervisor@demo.swachhtrack.in'],
      ['+919000000005', 'ulb@demo.swachhtrack.in'],
    ]);
    for (const user of DEMO_USERS) {
      expect(user.membershipId).toBe(demoId(`membership-${user.alias}`));
      expect(user.societyId).toBe(['resident', 'society'].includes(user.alias) ? demoId('society-0') : null);
      expect(user.contractorId).toBe(['collector', 'supervisor'].includes(user.alias) ? demoId('contractor-0') : null);
    }
  });
});
