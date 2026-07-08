import assert from 'node:assert/strict';
import test from 'node:test';
import type { PairingSession, SyncObjectMetadata } from '../types';
import type { SyncSecrets } from './syncSecrets';
import { EventSyncEngine } from './eventSyncEngine';
import { approveCompanionPairing, completeCompanionPairing, createCompanionPairingRequest, hashPairingCode } from './companionPairing';
import type { SupabaseControlPlaneClient } from './supabaseControlPlane';
import { createRepository } from './testSupport';
import { generateDeviceKeyPair } from './deviceKeys';
import { encodeCompanionKeyPackage, wrapRootKeyForCompanion } from './companionKeyPackage';
import { encryptSyncPayload } from './encryptedSyncObject';
import { encodeRepositorySnapshotPayload } from './syncSnapshot';
import { createStableSyncMediaReference, encodeSyncMediaPayload } from './syncMedia';

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
};

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
  assert.equal(approvedInput.keyEpoch, 4);
  assert.match(uploadedBody, /"keyEpoch":4/);
  assert.match(uploadedBody, /"keyEpoch":"4"/);
});

test('newly paired companion can hydrate media encrypted before key rotation', async () => {
  const repository = await createRepository();
  const companion = await generateDeviceKeyPair();
  const epochOneRootKey = crypto.getRandomValues(new Uint8Array(32));
  const epochTwoRootKey = crypto.getRandomValues(new Uint8Array(32));
  const mediaId = 'media-revoked-photo';
  const mediaDriveFileId = 'drive-media-old';
  const photoReference = createStableSyncMediaReference(mediaId, mediaDriveFileId);
  const encryptedMedia = await encryptSyncPayload(
    epochOneRootKey,
    'media',
    encodeSyncMediaPayload(mediaId, 'image/png', new TextEncoder().encode('photo')),
    { keyEpoch: 1 },
  );
  const snapshot = {
    diaries: [{ id: 'diary-default', name: 'Diary', emoji: 'D', color: '#000', isLocked: false, entryCount: 1, lastUpdated: 'Today' }],
    entries: [{
      id: 'entry-photo', diaryId: 'diary-default', date: '2026-07-06', title: 'Photo',
      body: '', moodName: 'Calm', moodEmoji: '', tags: [], photoUris: [photoReference],
      photoCount: 1, wordCount: 0, createdAt: 1, updatedAt: 2,
    }],
    notes: [],
    syncRecordVersions: { 'entry:entry-photo': 1 },
    syncMediaPointers: {
      '4': {
        mediaId,
        sequence: 4,
        driveFileId: mediaDriveFileId,
        sha256: encryptedMedia.sha256,
        sizeBytes: encryptedMedia.bytes.byteLength,
        createdByDeviceId: 'old-web',
        createdAt: '2026-07-06T00:00:00.000Z',
        keyEpoch: 1,
      },
    },
  };
  const encryptedSnapshot = await encryptSyncPayload(
    epochTwoRootKey,
    'snapshot',
    encodeRepositorySnapshotPayload(snapshot, 'account-1', 6),
    { keyEpoch: 2 },
  );
  const keyPackageBytes = encodeCompanionKeyPackage(await wrapRootKeyForCompanion(
    epochTwoRootKey,
    'account-1',
    companion.publicKey,
    { keyEpoch: 2, accountRootKeys: { 1: epochOneRootKey, 2: epochTwoRootKey } },
  ));
  const objects: SyncObjectMetadata[] = [
    {
      id: 'key-object', accountId: 'account-1', sequence: 2, driveFileId: 'drive-key',
      objectKind: 'key_package', sha256: await sha256Hex(keyPackageBytes), sizeBytes: keyPackageBytes.byteLength,
      createdByDeviceId: 'primary', createdAt: '2026-07-06T00:00:00.000Z', keyEpoch: 2,
    },
    {
      id: 'snapshot-object', accountId: 'account-1', sequence: 6, driveFileId: 'drive-snapshot',
      objectKind: 'snapshot', sha256: encryptedSnapshot.sha256, sizeBytes: encryptedSnapshot.bytes.byteLength,
      createdByDeviceId: 'primary', createdAt: '2026-07-06T00:00:01.000Z', keyEpoch: 2,
    },
  ];
  const approvedSession: PairingSession = {
    id: 'pair-repair',
    accountId: 'account-1',
    requestedDevicePublicKey: companion.publicKey,
    requestedDisplayName: 'Browser',
    requestedPlatform: 'web',
    pairingCodeHash: await hashPairingCode('12345678'),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    approvedByPrimaryDeviceId: 'primary',
    approvedAt: new Date().toISOString(),
    approvedDeviceId: 'web-2',
    keyPackageDriveFileId: 'drive-key',
    keyPackageSha256: objects[0].sha256,
    keyPackageSizeBytes: objects[0].sizeBytes,
  };
  const calls: string[] = [];
  const controlPlane = {
    getPairingSession: async () => ({
      session: approvedSession,
      device: {
        id: 'web-2', accountId: 'account-1', role: 'web_companion', publicKey: companion.publicKey,
        displayName: 'Browser', platform: 'web', createdAt: '', lastSeenAt: '',
        revokedAt: null, replacedByDeviceId: null,
      },
      keyObject: objects[0],
    }),
    getLatestRestoreManifest: async () => {
      calls.push('manifest');
      return { manifestObject: null, coreSnapshotObject: null, currentSyncSequence: 6, keyEpoch: 2 };
    },
    listSyncObjectsAfter: async (_deviceId: string, afterSequence: number) => {
      calls.push('legacy-list');
      return objects.filter(object => object.sequence > afterSequence);
    },
    updateDeviceCursor: async () => ({}),
  } as unknown as SupabaseControlPlaneClient;
  const files = new Map<string, Uint8Array>([
    ['drive-key', keyPackageBytes],
    ['drive-snapshot', encryptedSnapshot.bytes],
    [mediaDriveFileId, encryptedMedia.bytes],
  ]);
  let savedSecrets: SyncSecrets | null = null;

  await completeCompanionPairing({
    pending: {
      session: approvedSession,
      pairingCode: '12345678',
      devicePublicKey: companion.publicKey,
      devicePrivateKey: companion.privateKeyJwk,
    },
    repository,
    controlPlane,
    googleSession: { userId: 'google-1', email: 'writer@example.com', displayName: null, accessToken: 'drive-token' },
    supabaseSession: { accessToken: 'supabase-token', refreshToken: 'refresh', expiresAt: 2_000_000_000 },
    saveSecrets: async secrets => { savedSecrets = secrets; },
    download: async (_session, fileId) => files.get(fileId)!,
  });

  assert.deepEqual(savedSecrets?.accountRootKeys?.[1], epochOneRootKey);
  assert.deepEqual(savedSecrets?.accountRootKeys?.[2], epochTwoRootKey);
  assert.deepEqual(calls.slice(0, 2), ['manifest', 'legacy-list']);

  const engine = new EventSyncEngine(repository, {
    isOnline: () => true,
    loadSecrets: async () => savedSecrets,
    restoreGoogleSession: async () => ({ userId: 'google-1', email: 'writer@example.com', displayName: null, accessToken: 'drive-token' }),
    createControlPlane: () => controlPlane,
    download: async (_session, fileId) => files.get(fileId)!,
  });
  const hydrated = await engine.hydrateEntries(await repository.listEntries());

  assert.equal(hydrated[0].photoUris[0], 'data:image/png;base64,cGhvdG8=');
});

test('companion restore does not fall back to full snapshot when a manifest restore fails', async () => {
  const repository = await createRepository();
  const companion = await generateDeviceKeyPair();
  const accountRootKey = crypto.getRandomValues(new Uint8Array(32));
  const keyPackageBytes = encodeCompanionKeyPackage(await wrapRootKeyForCompanion(
    accountRootKey,
    'account-1',
    companion.publicKey,
    { keyEpoch: 1, accountRootKeys: { 1: accountRootKey } },
  ));
  const keyObject: SyncObjectMetadata = {
    id: 'key-object', accountId: 'account-1', sequence: 2, driveFileId: 'drive-key',
    objectKind: 'key_package', sha256: await sha256Hex(keyPackageBytes), sizeBytes: keyPackageBytes.byteLength,
    createdByDeviceId: 'primary', createdAt: '2026-07-06T00:00:00.000Z', keyEpoch: 1,
  };
  const approvedSession: PairingSession = {
    id: 'pair-manifest-fail',
    accountId: 'account-1',
    requestedDevicePublicKey: companion.publicKey,
    requestedDisplayName: 'Browser',
    requestedPlatform: 'web',
    pairingCodeHash: await hashPairingCode('12345678'),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    approvedByPrimaryDeviceId: 'primary',
    approvedAt: new Date().toISOString(),
    approvedDeviceId: 'web-2',
    keyPackageDriveFileId: 'drive-key',
    keyPackageSha256: keyObject.sha256,
    keyPackageSizeBytes: keyObject.sizeBytes,
  };
  let legacyListCalls = 0;
  const controlPlane = {
    getPairingSession: async () => ({
      session: approvedSession,
      device: {
        id: 'web-2', accountId: 'account-1', role: 'web_companion', publicKey: companion.publicKey,
        displayName: 'Browser', platform: 'web', createdAt: '', lastSeenAt: '',
        revokedAt: null, replacedByDeviceId: null,
      },
      keyObject,
    }),
    getLatestRestoreManifest: async () => ({
      manifestObject: {
        id: 'manifest-object', accountId: 'account-1', sequence: 5, driveFileId: 'drive-bad-manifest',
        objectKind: 'manifest', sha256: 'not-the-bad-bytes-sha', sizeBytes: 3,
        createdByDeviceId: 'primary', createdAt: '2026-07-06T00:00:01.000Z', keyEpoch: 1,
      },
      coreSnapshotObject: null,
      currentSyncSequence: 5,
      keyEpoch: 1,
    }),
    listSyncObjectsAfter: async () => {
      legacyListCalls += 1;
      return [];
    },
    updateDeviceCursor: async () => ({}),
  } as unknown as SupabaseControlPlaneClient;
  const files = new Map<string, Uint8Array>([
    ['drive-key', keyPackageBytes],
    ['drive-bad-manifest', new TextEncoder().encode('bad')],
  ]);

  await assert.rejects(
    () => completeCompanionPairing({
      pending: {
        session: approvedSession,
        pairingCode: '12345678',
        devicePublicKey: companion.publicKey,
        devicePrivateKey: companion.privateKeyJwk,
      },
      repository,
      controlPlane,
      googleSession: { userId: 'google-1', email: 'writer@example.com', displayName: null, accessToken: 'drive-token' },
      supabaseSession: { accessToken: 'supabase-token', refreshToken: 'refresh', expiresAt: 2_000_000_000 },
      saveSecrets: async () => undefined,
      download: async (_session, fileId) => files.get(fileId)!,
    }),
    /integrity check failed|checksum|manifest|decrypt|invalid/i,
  );
  assert.equal(legacyListCalls, 0);
});
