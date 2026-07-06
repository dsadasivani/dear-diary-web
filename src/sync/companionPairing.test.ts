import assert from 'node:assert/strict';
import test from 'node:test';
import type { PairingSession } from '../types';
import { createCompanionPairingRequest, hashPairingCode } from './companionPairing';
import type { SupabaseControlPlaneClient } from './supabaseControlPlane';

test('creates a short-lived web pairing request with hashed code and device key bundle', async () => {
  let request: any;
  const session: PairingSession = {
    id: 'pair-1',
    accountId: 'account-1',
    requestedDevicePublicKey: '',
    requestedDisplayName: 'Browser',
    requestedPlatform: 'web',
    pairingCodeHash: '',
    expiresAt: '2026-07-05T00:10:00.000Z',
    approvedByPrimaryDeviceId: null,
    approvedAt: null,
    approvedDeviceId: null,
    keyPackageDriveFileId: null,
    keyPackageSha256: null,
    keyPackageSizeBytes: null,
  };
  const controlPlane = {
    createPairingSession: async (input: any) => {
      request = input;
      return { ...session, requestedDevicePublicKey: input.requestedDevicePublicKey, pairingCodeHash: input.pairingCodeHash };
    },
  } as unknown as SupabaseControlPlaneClient;

  const pending = await createCompanionPairingRequest({
    controlPlane,
    displayName: 'Browser',
    platform: 'web',
    now: Date.parse('2026-07-05T00:00:00.000Z'),
  });

  assert.match(pending.pairingCode, /^\d{8}$/);
  assert.equal(request.pairingCodeHash, await hashPairingCode(pending.pairingCode));
  assert.equal(request.expiresAt, '2026-07-05T00:10:00.000Z');
  assert.equal(JSON.parse(pending.devicePublicKey).encryption.crv, 'P-256');
  assert.equal(JSON.parse(pending.devicePrivateKey).encryption.kty, 'EC');
});
