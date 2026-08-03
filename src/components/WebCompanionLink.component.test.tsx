import { describe, expect, it } from 'vitest';
import { canCompleteWebCompanionPairing } from './WebCompanionLink';

describe('WebCompanionLink', () => {
  it('waits for the encrypted package before completing an approved pairing', () => {
    expect(canCompleteWebCompanionPairing('REQUESTED')).toBe(false);
    expect(canCompleteWebCompanionPairing('APPROVED')).toBe(false);
    expect(canCompleteWebCompanionPairing('KEY_PACKAGE_PENDING')).toBe(false);
    expect(canCompleteWebCompanionPairing('KEY_PACKAGE_AVAILABLE')).toBe(true);
    expect(canCompleteWebCompanionPairing('COMPLETED')).toBe(true);
  });
});
