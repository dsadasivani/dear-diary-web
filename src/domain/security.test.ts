import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_SECURITY_CONFIG } from '../repositories/defaults';
import {
  bindGoogleRecoveryAccount,
  createInitialPin,
  createInitialPinWithRecovery,
  resetPinAfterVerifiedRecovery,
  requiresRecoveryQuestionForDevice,
  unlockWithPin,
  updatePinWithCurrentPin,
  verifyPin,
  verifyRecoveryAnswer,
} from './security';

test('creates a PIN and verifies PIN and recovery answer without mutating its input', () => {
  const original = { ...DEFAULT_SECURITY_CONFIG };
  const configured = createInitialPinWithRecovery(
    original,
    '1234',
    'first-pet',
    '  Sunday  ',
  );

  assert.equal(original.isPinCreated, false);
  assert.equal(verifyPin(configured, '1234'), true);
  assert.equal(verifyPin(configured, '4321'), false);
  assert.equal(verifyRecoveryAnswer(configured, 'sunday'), true);
  assert.equal(unlockWithPin(configured, '4321'), null);
  assert.equal(unlockWithPin(configured, '1234')?.isLocked, false);
});

test('can create a local PIN before encrypted-account recovery is selected', () => {
  const configured = createInitialPin(DEFAULT_SECURITY_CONFIG, '1234');
  assert.equal(verifyPin(configured, '1234'), true);
  assert.equal(configured.recoveryQuestionId, undefined);
});

test('changes and recovers a PIN while preserving recovery metadata', () => {
  const configured = createInitialPinWithRecovery(
    DEFAULT_SECURITY_CONFIG,
    '1234',
    'favorite-book',
    'Matilda',
  );
  const changed = updatePinWithCurrentPin(configured, '1234', '87654321');
  assert.equal(verifyPin(changed, '1234'), false);
  assert.equal(verifyPin(changed, '87654321'), true);

  const recovered = resetPinAfterVerifiedRecovery(changed, '5555');
  assert.equal(verifyPin(recovered, '5555'), true);
  assert.equal(verifyRecoveryAnswer(recovered, 'matilda'), true);
});

test('keeps Google recovery binding pinned to the first linked account', () => {
  const first = bindGoogleRecoveryAccount(DEFAULT_SECURITY_CONFIG, {
    userId: 'google-user-1',
    email: 'writer@example.com',
  });
  assert.equal(first.ok, true);
  assert.equal(first.config.linkedGoogleUserId, 'google-user-1');

  const mismatch = bindGoogleRecoveryAccount(first.config, {
    userId: 'google-user-2',
    email: 'other@example.com',
  });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.error || '', /writer@example\.com/);
});

test('does not require mobile recovery-question onboarding on a paired web companion', () => {
  const withoutRecovery = {
    ...DEFAULT_SECURITY_CONFIG,
    isPinCreated: true,
    pinHash: 'hash',
    pinSalt: 'salt',
    pinLength: 4 as const,
  };

  assert.equal(requiresRecoveryQuestionForDevice(withoutRecovery, 'web_companion'), false);
  assert.equal(requiresRecoveryQuestionForDevice(withoutRecovery, 'primary_mobile'), true);
  assert.equal(requiresRecoveryQuestionForDevice(withoutRecovery), true);
  assert.equal(requiresRecoveryQuestionForDevice({
    ...withoutRecovery,
    linkedGoogleUserId: 'google-user-1',
  }, 'primary_mobile'), false);
});
