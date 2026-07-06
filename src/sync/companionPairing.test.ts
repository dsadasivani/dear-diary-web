import assert from 'node:assert/strict';
import test from 'node:test';
import type { PairingSession } from '../types';
import { approveCompanionPairing, createCompanionPairingRequest, hashPairingCode } from './companionPairing';
import type { SupabaseControlPlaneClient } from './supabaseControlPlane';
import { createRepository } from './testSupport';
import { generateDeviceKeyPair } from './deviceKeys';

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

test('approves companions with an epoch-aware key package', async () => {
  const repository = await createRepository();
  const companion = await generateDeviceKeyPair();
  await repository.saveLocalSyncAccountState({
    accountId: 'account-1',
    deviceId: 'primary-1',
    deviceRole: 'primary_mobile',
    googleUserId: 'google-1',
    googleEmail: 'writer@example.com',
    devicePublicKey: '{}',
    recoveryKeyDriveFileId: 'key-1',
    latestSnapshotDriveFileId: 'snapshot-1',
    currentSyncSequence: 8,
    keyEpoch: 3,
    linkedAt: 1,
  });
  const rootKey = crypto.getRandomValues(new Uint8Array(32));
  const secrets = {
    version: 1,
    accountId: 'account-1',
    accountRootKey: rootKey,
    devicePrivateKeyJwk: '{}',
    supabaseSession: { accessToken: 'token', refreshToken: 'refresh' },
  } as const;
  const pairingCode = '12345678';
  const pairingCodeHash = await hashPairingCode(pairingCode);
  const session: PairingSession = {
    id: 'pair-epoch',
    accountId: 'account-1',
    requestedDevicePublicKey: companion.publicKey,
    requestedDisplayName: 'Browser',
    requestedPlatform: 'web',
    pairingCodeHash,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    approvedByPrimaryDeviceId: null,
    approvedAt: null,
    approvedDeviceId: null,
    keyPackageDriveFileId: null,
    keyPackageSha256: null,
    keyPackageSizeBytes: null,
  };
  let approvedInput: any;
  const controlPlane = {
    getPairingSession: async () => ({ session, device: null, keyObject: null }),
    lookupCurrentGoogleAccount: async () => ({
      id: 'account-1',
      googleUserId: 'google-1',
      googleEmail: 'writer@example.com',
      createdAt: '',
      activePrimaryDeviceId: 'primary-1',
      currentSyncSequence: 8,
      currentSnapshotSequence: 8,
      currentKeyEpoch: 4,
      recoveryConfigured: true,
    }),
    approvePairingSession: async (input: any) => {
      approvedInput = input;
      return {
        session: { ...session, approvedAt: new Date().toISOString(), approvedDeviceId: 'device-2' },
        device: {
          id: 'device-2',
          accountId: 'account-1',
          role: 'web_companion',
          publicKey: companion.publicKey,
          displayName: 'Browser',
          platform: 'web',
          createdAt: '',
          lastSeenAt: '',
          revokedAt: null,
          replacedByDeviceId: null,
        },
        keyObject: null,
      };
    },
  } as unknown as SupabaseControlPlaneClient;
  const originalFetch = globalThis.fetch;
  let uploadedBody = '';
  globalThis.fetch = async (_input: RequestInfo | URL, init: RequestInit = {}) => {
    uploadedBody = Buffer.from(init.body as ArrayBuffer).toString('utf8');
    return new Response(JSON.stringify({
      id: 'drive-key-epoch',
      name: '/key-packages/companion-pair-epoch.ddkey',
      size: '1234',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    await approveCompanionPairing({
      sessionId: session.id,
      pairingCode,
      repository,
      controlPlane,
      googleSession: { userId: 'google-1', email: 'writer@example.com', displayName: null, accessToken: 'drive-token' },
      loadSecrets: async () => secrets,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(approvedInput.afterSequence, 8);
  assert.equal(approvedInput.driveFileId, 'drive-key-epoch');
  assert.match(uploadedBody, /"keyEpoch":4/);
  assert.match(uploadedBody, /"keyEpoch":"4"/);
});
