import assert from 'node:assert/strict';
import test from 'node:test';
import type { SyncDevice, SyncObjectMetadata } from '../types';
import { buildStorageBreakdown, EventSyncEngine, SyncConflictError } from './eventSyncEngine';
import { SupabaseControlPlaneError, type SupabaseControlPlaneClient } from './supabaseControlPlane';
import type { SyncSecrets } from './syncSecrets';
import { createRepository } from './testSupport';
import { encodeCompanionKeyPackage, wrapRootKeyForCompanion } from './companionKeyPackage';
import { generateDeviceKeyPair } from './deviceKeys';
import { createSyncDomainEvent, encodeSyncDomainEvent } from './domainEvents';
import { decryptSyncPayload, encryptSyncPayload } from './encryptedSyncObject';
import { parseRepositorySnapshotPayload } from './syncSnapshot';
import {
  createStableSyncMediaReference,
  decodeSyncMediaPayload,
  decodeSyncThumbnailPayload,
  parseSyncMediaReference,
} from './syncMedia';
import {
  buildPartitionManifest,
  encodePartitionManifestPayload,
  encodePartitionSnapshotPayload,
  parsePartitionManifestPayload,
} from './syncPartitioning';

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
};

test('storage breakdown reports unreferenced media as pending cleanup instead of active photos', () => {
  const breakdown = buildStorageBreakdown([
    {
      id: 'event-file',
      name: '/events/1.ddevent',
      size: 100,
      appProperties: { objectKind: 'event' },
    },
    {
      id: 'live-photo',
      name: '/media/live.ddmedia',
      size: 200,
      appProperties: { objectKind: 'media', mediaKind: 'image' },
    },
    {
      id: 'live-photo-thumb',
      name: '/thumbnails/live.ddthumb',
      size: 20,
      appProperties: { objectKind: 'thumbnail', mediaKind: 'image', sourceDriveFileId: 'live-photo' },
    },
    {
      id: 'deleted-photo',
      name: '/media/deleted.ddmedia',
      size: 500,
      appProperties: { objectKind: 'media', mediaKind: 'image' },
    },
    {
      id: 'deleted-photo-thumb',
      name: '/thumbnails/deleted.ddthumb',
      size: 50,
      appProperties: { objectKind: 'thumbnail', mediaKind: 'image', sourceDriveFileId: 'deleted-photo' },
    },
  ], ['live-photo', 'live-photo-thumb']);

  assert.equal(breakdown.journalDataBytes, 100);
  assert.equal(breakdown.imageBytes, 220);
  assert.equal(breakdown.audioBytes, 0);
  assert.equal(breakdown.pendingCleanupBytes, 550);
});

test('uploads and commits an encrypted event before applying it locally', async () => {
  const repository = await createRepository();
  await repository.saveLocalSyncAccountState({
    accountId: 'account-1', deviceId: 'device-1', deviceRole: 'primary_mobile',
    googleUserId: 'google-1', googleEmail: 'writer@example.com', devicePublicKey: '{}',
    recoveryKeyDriveFileId: 'key-1', latestSnapshotDriveFileId: 'snapshot-1',
    currentSyncSequence: 2, partitionedSyncEnabled: true, linkedAt: 1,
  });
  const device: SyncDevice = {
    id: 'device-1', accountId: 'account-1', role: 'primary_mobile', publicKey: '{}',
    displayName: 'Phone', platform: 'android', createdAt: '', lastSeenAt: '',
    revokedAt: null, replacedByDeviceId: null,
  };
  let committedInput: any;
  let partitionCursorInput: any;
  let uploadedBytes = 0;
  const controlPlane = {
    getDeviceStatus: async () => device,
    listSyncObjectsAfter: async () => [],
    updateDeviceCursor: async () => ({}),
    updatePartitionCursor: async (input: any) => { partitionCursorInput = input; return {}; },
    commitSyncObject: async (input: any): Promise<SyncObjectMetadata> => {
      committedInput = input;
      return {
        id: 'object-1', accountId: 'account-1', sequence: 3, driveFileId: input.driveFileId,
        objectKind: 'event', sha256: input.sha256, sizeBytes: input.sizeBytes,
        createdByDeviceId: 'device-1', createdAt: '', recordType: 'note', recordId: 'note-1',
        baseRecordVersion: 0, recordVersion: 1,
      };
    },
  } as unknown as SupabaseControlPlaneClient;
  const engine = new EventSyncEngine(repository, {
    isOnline: () => true,
    now: () => 1,
    loadSecrets: async () => ({
      version: 1, accountId: 'account-1', accountRootKey: new Uint8Array(32),
      devicePrivateKeyJwk: '{}',
      supabaseSession: { accessToken: 'supabase-token', refreshToken: 'refresh', expiresAt: 2_000_000_000 },
    }),
    restoreGoogleSession: async () => ({
      userId: 'google-1', email: 'writer@example.com', displayName: null, accessToken: 'drive-token',
    }),
    createControlPlane: () => controlPlane,
    upload: async input => { uploadedBytes = input.bytes.byteLength; return { id: 'drive-1' }; },
  });
  const note = {
    id: 'note-1', title: 'Committed', body: 'Encrypted first.', isPinned: false,
    tags: [], createdAt: 1, updatedAt: 1,
  };

  await engine.commitMutation('note', 'upsert', note.id, note);

  assert.ok(uploadedBytes > 0);
  assert.equal(committedInput.afterSequence, 2);
  assert.equal(committedInput.baseRecordVersion, 0);
  assert.equal(partitionCursorInput.partitionKey, 'month:1970-01');
  assert.equal(partitionCursorInput.lastAppliedSequence, 3);
  assert.equal((await repository.getPartitionHydrationState('month:1970-01')).status, 'hydrated');
  assert.deepEqual(await repository.getNote(note.id), note);
});

test('resumes an event-uploaded outbox write without reuploading the event', async () => {
  const repository = await createRepository();
  await repository.saveLocalSyncAccountState({
    accountId: 'account-1', deviceId: 'device-1', deviceRole: 'primary_mobile',
    googleUserId: 'google-1', googleEmail: 'writer@example.com', devicePublicKey: '{}',
    recoveryKeyDriveFileId: 'key-1', latestSnapshotDriveFileId: 'snapshot-1',
    currentSyncSequence: 2, linkedAt: 1,
  });
  const device: SyncDevice = {
    id: 'device-1', accountId: 'account-1', role: 'primary_mobile', publicKey: '{}',
    displayName: 'Phone', platform: 'android', createdAt: '', lastSeenAt: '',
    revokedAt: null, replacedByDeviceId: null,
  };
  let failCommit = true;
  let sequence = 2;
  let uploadCount = 0;
  let currentNow = 1;
  const controlPlane = {
    getDeviceStatus: async () => device,
    listSyncObjectsAfter: async () => [],
    updateDeviceCursor: async () => ({}),
    commitSyncObject: async (input: any): Promise<SyncObjectMetadata> => {
      if (failCommit) throw new Error('metadata unavailable');
      sequence += 1;
      return {
        id: `object-${sequence}`, accountId: 'account-1', sequence, driveFileId: input.driveFileId,
        objectKind: 'event', sha256: input.sha256, sizeBytes: input.sizeBytes,
        createdByDeviceId: 'device-1', createdAt: '', recordType: input.recordType, recordId: input.recordId,
        baseRecordVersion: input.baseRecordVersion, recordVersion: input.baseRecordVersion + 1,
        affectedRecords: input.affectedRecords || [],
      };
    },
  } as unknown as SupabaseControlPlaneClient;
  const engine = new EventSyncEngine(repository, {
    isOnline: () => true,
    now: () => currentNow,
    loadSecrets: async () => ({
      version: 1, accountId: 'account-1', accountRootKey: new Uint8Array(32),
      devicePrivateKeyJwk: '{}',
      supabaseSession: { accessToken: 'supabase-token', refreshToken: 'refresh', expiresAt: 2_000_000_000 },
    }),
    restoreGoogleSession: async () => ({
      userId: 'google-1', email: 'writer@example.com', displayName: null, accessToken: 'drive-token',
    }),
    createControlPlane: () => controlPlane,
    upload: async () => {
      uploadCount += 1;
      return { id: `drive-${uploadCount}` };
    },
  });
  const pendingNote = {
    id: 'note-pending', title: 'Pending', body: 'Resume me.', isPinned: false,
    tags: [], createdAt: 1, updatedAt: 1,
  };

  await assert.rejects(
    () => engine.commitMutation('note', 'upsert', pendingNote.id, pendingNote),
    /metadata unavailable/,
  );
  const failed = await repository.listSyncOutboxOperations(['failed']);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].eventDriveFileId, 'drive-1');
  assert.equal(failed[0].retryCount, 1);
  assert.equal(failed[0].nextRetryAt, 30_001);
  assert.equal(await repository.getNote(pendingNote.id), null);

  failCommit = false;
  currentNow = failed[0].nextRetryAt!;
  const nextNote = {
    id: 'note-next', title: 'Next', body: 'After resume.', isPinned: false,
    tags: [], createdAt: 1, updatedAt: 1,
  };
  await engine.commitMutation('note', 'upsert', nextNote.id, nextNote);

  assert.equal(uploadCount, 2);
  assert.equal((await repository.getNote(pendingNote.id))?.title, 'Pending');
  assert.equal((await repository.getNote(nextNote.id))?.title, 'Next');
  assert.equal((await repository.listSyncOutboxOperations()).length, 0);
});

test('resumes a failed outbox write that crashed before event upload completed', async () => {
  const repository = await createRepository();
  await repository.saveLocalSyncAccountState({
    accountId: 'account-1', deviceId: 'device-1', deviceRole: 'primary_mobile',
    googleUserId: 'google-1', googleEmail: 'writer@example.com', devicePublicKey: '{}',
    recoveryKeyDriveFileId: 'key-1', latestSnapshotDriveFileId: 'snapshot-1',
    currentSyncSequence: 2, linkedAt: 1,
  });
  const device: SyncDevice = {
    id: 'device-1', accountId: 'account-1', role: 'primary_mobile', publicKey: '{}',
    displayName: 'Phone', platform: 'android', createdAt: '', lastSeenAt: '',
    revokedAt: null, replacedByDeviceId: null,
  };
  let sequence = 2;
  let uploadCount = 0;
  let failUpload = true;
  let currentNow = 1;
  const controlPlane = {
    getDeviceStatus: async () => device,
    listSyncObjectsAfter: async () => [],
    updateDeviceCursor: async () => ({}),
    commitSyncObject: async (input: any): Promise<SyncObjectMetadata> => {
      sequence += 1;
      return {
        id: `object-${sequence}`, accountId: 'account-1', sequence, driveFileId: input.driveFileId,
        objectKind: 'event', sha256: input.sha256, sizeBytes: input.sizeBytes,
        createdByDeviceId: 'device-1', createdAt: '', recordType: input.recordType, recordId: input.recordId,
        baseRecordVersion: input.baseRecordVersion, recordVersion: input.baseRecordVersion + 1,
        affectedRecords: input.affectedRecords || [],
      };
    },
  } as unknown as SupabaseControlPlaneClient;
  const engine = new EventSyncEngine(repository, {
    isOnline: () => true,
    now: () => currentNow,
    loadSecrets: async () => ({
      version: 1, accountId: 'account-1', accountRootKey: new Uint8Array(32),
      devicePrivateKeyJwk: '{}',
      supabaseSession: { accessToken: 'supabase-token', refreshToken: 'refresh', expiresAt: 2_000_000_000 },
    }),
    restoreGoogleSession: async () => ({
      userId: 'google-1', email: 'writer@example.com', displayName: null, accessToken: 'drive-token',
    }),
    createControlPlane: () => controlPlane,
    upload: async () => {
      uploadCount += 1;
      if (failUpload) {
        failUpload = false;
        throw new Error('drive upload unavailable');
      }
      return { id: `drive-${uploadCount}` };
    },
  });
  const pendingNote = {
    id: 'note-upload-pending', title: 'Upload pending', body: 'Retry me.', isPinned: false,
    tags: [], createdAt: 1, updatedAt: 1,
  };

  await assert.rejects(
    () => engine.commitMutation('note', 'upsert', pendingNote.id, pendingNote),
    /drive upload unavailable/,
  );
  const failed = await repository.listSyncOutboxOperations(['failed']);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].retryCount, 1);
  assert.equal(failed[0].nextRetryAt, 30_001);
  assert.equal(failed[0].eventDriveFileId, undefined);
  assert.equal(await repository.getNote(pendingNote.id), null);

  currentNow = failed[0].nextRetryAt!;
  await engine.commitMutation('note', 'upsert', 'note-after-upload-retry', {
    id: 'note-after-upload-retry', title: 'After retry', body: '', isPinned: false,
    tags: [], createdAt: 1, updatedAt: 1,
  });

  assert.equal(uploadCount, 3);
  assert.equal((await repository.getNote(pendingNote.id))?.title, 'Upload pending');
  assert.equal((await repository.getNote('note-after-upload-retry'))?.title, 'After retry');
  assert.equal((await repository.listSyncOutboxOperations()).length, 0);
});

test('failed outbox writes wait for backoff without blocking later operations', async () => {
  const repository = await createRepository();
  await repository.saveLocalSyncAccountState({
    accountId: 'account-1', deviceId: 'device-1', deviceRole: 'primary_mobile',
    googleUserId: 'google-1', googleEmail: 'writer@example.com', devicePublicKey: '{}',
    recoveryKeyDriveFileId: 'key-1', latestSnapshotDriveFileId: 'snapshot-1',
    currentSyncSequence: 2, linkedAt: 1,
  });
  const device: SyncDevice = {
    id: 'device-1', accountId: 'account-1', role: 'primary_mobile', publicKey: '{}',
    displayName: 'Phone', platform: 'android', createdAt: '', lastSeenAt: '',
    revokedAt: null, replacedByDeviceId: null,
  };
  let currentNow = 1;
  let sequence = 2;
  let failFirstUpload = true;
  const uploadIds: string[] = [];
  const controlPlane = {
    getDeviceStatus: async () => device,
    listSyncObjectsAfter: async () => [],
    updateDeviceCursor: async () => ({}),
    commitSyncObject: async (input: any): Promise<SyncObjectMetadata> => {
      sequence += 1;
      return {
        id: `object-${sequence}`, accountId: 'account-1', sequence, driveFileId: input.driveFileId,
        objectKind: 'event', sha256: input.sha256, sizeBytes: input.sizeBytes,
        createdByDeviceId: 'device-1', createdAt: '', recordType: input.recordType, recordId: input.recordId,
        baseRecordVersion: input.baseRecordVersion, recordVersion: input.baseRecordVersion + 1,
        affectedRecords: input.affectedRecords || [],
      };
    },
  } as unknown as SupabaseControlPlaneClient;
  const engine = new EventSyncEngine(repository, {
    isOnline: () => true,
    now: () => currentNow,
    loadSecrets: async () => ({
      version: 1, accountId: 'account-1', accountRootKey: new Uint8Array(32),
      devicePrivateKeyJwk: '{}',
      supabaseSession: { accessToken: 'supabase-token', refreshToken: 'refresh', expiresAt: 2_000_000_000 },
    }),
    restoreGoogleSession: async () => ({
      userId: 'google-1', email: 'writer@example.com', displayName: null, accessToken: 'drive-token',
    }),
    createControlPlane: () => controlPlane,
    upload: async () => {
      if (failFirstUpload) {
        failFirstUpload = false;
        throw new Error('drive temporarily unavailable');
      }
      const id = `drive-${uploadIds.length + 1}`;
      uploadIds.push(id);
      return { id };
    },
  });

  const delayedNote = {
    id: 'note-delayed', title: 'Delayed', body: 'Retry after backoff.', isPinned: false,
    tags: [], createdAt: 1, updatedAt: 1,
  };
  await assert.rejects(
    () => engine.commitMutation('note', 'upsert', delayedNote.id, delayedNote),
    /drive temporarily unavailable/,
  );
  const [failed] = await repository.listSyncOutboxOperations(['failed']);
  assert.equal(failed.nextRetryAt, 30_001);

  await engine.commitMutation('note', 'upsert', 'note-later', {
    id: 'note-later', title: 'Later write', body: '', isPinned: false,
    tags: [], createdAt: 1, updatedAt: 1,
  });

  assert.equal(await repository.getNote(delayedNote.id), null);
  assert.equal((await repository.getNote('note-later'))?.title, 'Later write');
  assert.equal((await repository.listSyncOutboxOperations(['failed'])).length, 1);

  currentNow = 30_001;
  await engine.pullPending();

  assert.equal((await repository.getNote(delayedNote.id))?.title, 'Delayed');
  assert.equal((await repository.listSyncOutboxOperations()).length, 0);
});

test('resumes a media-uploaded outbox write without reuploading media', async () => {
  const repository = await createRepository();
  await repository.saveLocalSyncAccountState({
    accountId: 'account-1', deviceId: 'device-1', deviceRole: 'primary_mobile',
    googleUserId: 'google-1', googleEmail: 'writer@example.com', devicePublicKey: '{}',
    recoveryKeyDriveFileId: 'key-1', latestSnapshotDriveFileId: 'snapshot-1',
    currentSyncSequence: 2, linkedAt: 1,
  });
  const mediaId = 'media-uploaded-before-crash';
  const localUri = 'data:image/png;base64,aGVsbG8=';
  const reference = createStableSyncMediaReference(mediaId, 'drive-media-uploaded');
  const pendingEntry = {
    id: 'entry-media-uploaded',
    diaryId: 'diary-default',
    date: '2026-07-08',
    title: 'Media uploaded',
    body: '',
    moodName: 'Calm',
    moodEmoji: '',
    tags: [],
    photoUris: [reference],
    photoCount: 1,
    wordCount: 0,
    createdAt: 1,
    updatedAt: 1,
  };
  await repository.saveSyncOutboxOperation({
    operationId: 'outbox-media-uploaded',
    accountId: 'account-1',
    deviceId: 'device-1',
    partitionKey: 'month:2026-07',
    affectedPartitionKeys: ['month:2026-07'],
    recordType: 'entry',
    recordId: pendingEntry.id,
    operation: 'upsert',
    payload: pendingEntry,
    baseRecordVersion: 0,
    uploadedObjects: [{
      driveFileId: 'drive-media-uploaded',
      objectKind: 'media',
      sha256: 'media-sha',
      sizeBytes: 5,
      partitionKey: 'month:2026-07',
      mediaId,
      localUri,
      reference,
    }],
    state: 'media_uploaded',
    createdAt: 1,
    updatedAt: 1,
  });
  const device: SyncDevice = {
    id: 'device-1', accountId: 'account-1', role: 'primary_mobile', publicKey: '{}',
    displayName: 'Phone', platform: 'android', createdAt: '', lastSeenAt: '',
    revokedAt: null, replacedByDeviceId: null,
  };
  let sequence = 2;
  const uploadKinds: string[] = [];
  const batchKinds: string[] = [];
  const controlPlane = {
    getDeviceStatus: async () => device,
    listSyncObjectsAfter: async () => [],
    updateDeviceCursor: async () => ({}),
    updatePartitionCursor: async () => ({}),
    commitSyncBatch: async (input: any): Promise<SyncObjectMetadata[]> => {
      batchKinds.push(...input.objects.map((object: any) => object.objectKind));
      return input.objects.map((object: any) => {
        sequence += 1;
        return {
          id: `object-${sequence}`, accountId: 'account-1', sequence, driveFileId: object.driveFileId,
          objectKind: object.objectKind, sha256: object.sha256, sizeBytes: object.sizeBytes,
          createdByDeviceId: 'device-1', createdAt: '',
          recordType: object.objectKind === 'event' ? input.recordType : null,
          recordId: object.objectKind === 'event' ? input.recordId : null,
          baseRecordVersion: object.objectKind === 'event' ? input.baseRecordVersion : null,
          recordVersion: object.objectKind === 'event' ? input.baseRecordVersion + 1 : null,
          affectedRecords: object.objectKind === 'event' ? [] : undefined,
          partitionKey: object.partitionKey,
          keyEpoch: input.keyEpoch,
          operationId: input.operationId,
        };
      });
    },
    commitSyncObject: async (input: any): Promise<SyncObjectMetadata> => {
      sequence += 1;
      return {
        id: `object-${sequence}`, accountId: 'account-1', sequence, driveFileId: input.driveFileId,
        objectKind: 'event', sha256: input.sha256, sizeBytes: input.sizeBytes,
        createdByDeviceId: 'device-1', createdAt: '', recordType: input.recordType, recordId: input.recordId,
        baseRecordVersion: input.baseRecordVersion, recordVersion: input.baseRecordVersion + 1,
        affectedRecords: input.affectedRecords || [], partitionKey: input.partitionKey,
        keyEpoch: input.keyEpoch, operationId: input.operationId,
      };
    },
  } as unknown as SupabaseControlPlaneClient;
  const engine = new EventSyncEngine(repository, {
    isOnline: () => true,
    now: () => 1,
    loadSecrets: async () => ({
      version: 1, accountId: 'account-1', accountRootKey: new Uint8Array(32),
      devicePrivateKeyJwk: '{}',
      supabaseSession: { accessToken: 'supabase-token', refreshToken: 'refresh', expiresAt: 2_000_000_000 },
    }),
    restoreGoogleSession: async () => ({
      userId: 'google-1', email: 'writer@example.com', displayName: null, accessToken: 'drive-token',
    }),
    createControlPlane: () => controlPlane,
    upload: async (input: any) => {
      uploadKinds.push(input.objectKind);
      return { id: `drive-${input.objectKind}-${uploadKinds.length}` };
    },
  });

  await engine.commitMutation('note', 'upsert', 'note-after-media-retry', {
    id: 'note-after-media-retry', title: 'After media retry', body: '', isPinned: false,
    tags: [], createdAt: 1, updatedAt: 1,
  });

  assert.deepEqual(batchKinds, ['media', 'event']);
  assert.deepEqual(uploadKinds, ['event', 'event']);
  assert.equal((await repository.getEntry(pendingEntry.id))?.photoUris[0], reference);
  assert.equal((await repository.getSyncMediaPointerByMediaId(mediaId))?.driveFileId, 'drive-media-uploaded');
  assert.equal((await repository.getNote('note-after-media-retry'))?.title, 'After media retry');
  assert.equal((await repository.listSyncOutboxOperations()).length, 0);
});

test('resumes a committed outbox write by applying it idempotently before a new write', async () => {
  const repository = await createRepository();
  await repository.saveLocalSyncAccountState({
    accountId: 'account-1', deviceId: 'device-1', deviceRole: 'primary_mobile',
    googleUserId: 'google-1', googleEmail: 'writer@example.com', devicePublicKey: '{}',
    recoveryKeyDriveFileId: 'key-1', latestSnapshotDriveFileId: 'snapshot-1',
    currentSyncSequence: 2, linkedAt: 1,
  });
  const committedNote = {
    id: 'note-committed', title: 'Committed outbox', body: 'Apply me.', isPinned: false,
    tags: [], createdAt: 1, updatedAt: 1,
  };
  await repository.saveSyncOutboxOperation({
    operationId: 'outbox-committed',
    accountId: 'account-1',
    deviceId: 'device-1',
    partitionKey: 'month:1970-01',
    affectedPartitionKeys: ['month:1970-01'],
    recordType: 'note',
    recordId: committedNote.id,
    operation: 'upsert',
    payload: committedNote,
    baseRecordVersion: 0,
    uploadedObjects: [],
    eventDriveFileId: 'drive-committed',
    eventSha256: 'sha',
    eventSizeBytes: 10,
    committedObjects: [{
      id: 'object-3', accountId: 'account-1', sequence: 3, driveFileId: 'drive-committed',
      objectKind: 'event', sha256: 'sha', sizeBytes: 10, createdByDeviceId: 'device-1',
      createdAt: '', recordType: 'note', recordId: committedNote.id, baseRecordVersion: 0,
      recordVersion: 1, affectedRecords: [], partitionKey: 'month:1970-01',
    }],
    state: 'committed',
    createdAt: 1,
    updatedAt: 1,
  });
  const device: SyncDevice = {
    id: 'device-1', accountId: 'account-1', role: 'primary_mobile', publicKey: '{}',
    displayName: 'Phone', platform: 'android', createdAt: '', lastSeenAt: '',
    revokedAt: null, replacedByDeviceId: null,
  };
  let sequence = 3;
  const controlPlane = {
    getDeviceStatus: async () => device,
    listSyncObjectsAfter: async () => [],
    updateDeviceCursor: async () => ({}),
    commitSyncObject: async (input: any): Promise<SyncObjectMetadata> => {
      sequence += 1;
      return {
        id: `object-${sequence}`, accountId: 'account-1', sequence, driveFileId: input.driveFileId,
        objectKind: 'event', sha256: input.sha256, sizeBytes: input.sizeBytes,
        createdByDeviceId: 'device-1', createdAt: '', recordType: input.recordType, recordId: input.recordId,
        baseRecordVersion: input.baseRecordVersion, recordVersion: input.baseRecordVersion + 1,
        affectedRecords: input.affectedRecords || [],
      };
    },
  } as unknown as SupabaseControlPlaneClient;
  const engine = new EventSyncEngine(repository, {
    isOnline: () => true,
    now: () => 1,
    loadSecrets: async () => ({
      version: 1, accountId: 'account-1', accountRootKey: new Uint8Array(32),
      devicePrivateKeyJwk: '{}',
      supabaseSession: { accessToken: 'supabase-token', refreshToken: 'refresh', expiresAt: 2_000_000_000 },
    }),
    restoreGoogleSession: async () => ({
      userId: 'google-1', email: 'writer@example.com', displayName: null, accessToken: 'drive-token',
    }),
    createControlPlane: () => controlPlane,
    upload: async () => ({ id: `drive-${sequence + 1}` }),
  });

  await engine.commitMutation('note', 'upsert', 'note-next', {
    id: 'note-next', title: 'Next', body: '', isPinned: false, tags: [], createdAt: 1, updatedAt: 1,
  });

  assert.equal((await repository.getNote(committedNote.id))?.title, 'Committed outbox');
  assert.equal((await repository.getNote('note-next'))?.title, 'Next');
  assert.equal((await repository.listSyncOutboxOperations()).length, 0);
});

test('pullPending resumes a committed outbox write at startup', async () => {
  const repository = await createRepository();
  await repository.saveLocalSyncAccountState({
    accountId: 'account-1', deviceId: 'device-1', deviceRole: 'primary_mobile',
    googleUserId: 'google-1', googleEmail: 'writer@example.com', devicePublicKey: '{}',
    recoveryKeyDriveFileId: 'key-1', latestSnapshotDriveFileId: 'snapshot-1',
    currentSyncSequence: 2, linkedAt: 1,
  });
  const committedNote = {
    id: 'note-startup-committed', title: 'Startup committed outbox', body: 'Apply on launch.',
    isPinned: false, tags: [], createdAt: 1, updatedAt: 1,
  };
  await repository.saveSyncOutboxOperation({
    operationId: 'outbox-startup-committed',
    accountId: 'account-1',
    deviceId: 'device-1',
    partitionKey: 'month:1970-01',
    affectedPartitionKeys: ['month:1970-01'],
    recordType: 'note',
    recordId: committedNote.id,
    operation: 'upsert',
    payload: committedNote,
    baseRecordVersion: 0,
    uploadedObjects: [],
    eventDriveFileId: 'drive-startup-committed',
    eventSha256: 'sha',
    eventSizeBytes: 10,
    committedObjects: [{
      id: 'object-3', accountId: 'account-1', sequence: 3, driveFileId: 'drive-startup-committed',
      objectKind: 'event', sha256: 'sha', sizeBytes: 10, createdByDeviceId: 'device-1',
      createdAt: '', recordType: 'note', recordId: committedNote.id, baseRecordVersion: 0,
      recordVersion: 1, affectedRecords: [], partitionKey: 'month:1970-01',
    }],
    state: 'committed',
    createdAt: 1,
    updatedAt: 1,
  });
  const device: SyncDevice = {
    id: 'device-1', accountId: 'account-1', role: 'primary_mobile', publicKey: '{}',
    displayName: 'Phone', platform: 'android', createdAt: '', lastSeenAt: '',
    revokedAt: null, replacedByDeviceId: null,
  };
  const cursorUpdates: number[] = [];
  const controlPlane = {
    getDeviceStatus: async () => device,
    listSyncObjectsAfter: async () => [],
    updateDeviceCursor: async (input: any) => { cursorUpdates.push(input.lastAppliedSequence); return {}; },
  } as unknown as SupabaseControlPlaneClient;
  const engine = new EventSyncEngine(repository, {
    isOnline: () => true,
    now: () => 1,
    loadSecrets: async () => ({
      version: 1, accountId: 'account-1', accountRootKey: new Uint8Array(32),
      devicePrivateKeyJwk: '{}',
      supabaseSession: { accessToken: 'supabase-token', refreshToken: 'refresh', expiresAt: 2_000_000_000 },
    }),
    restoreGoogleSession: async () => ({
      userId: 'google-1', email: 'writer@example.com', displayName: null, accessToken: 'drive-token',
    }),
    createControlPlane: () => controlPlane,
  });

  await engine.pullPending();

  assert.equal((await repository.getNote(committedNote.id))?.title, 'Startup committed outbox');
  assert.equal((await repository.listSyncOutboxOperations()).length, 0);
  assert.ok(cursorUpdates.includes(3));
});

test('rejects writes while offline without changing local content', async () => {
  const repository = await createRepository();
  const engine = new EventSyncEngine(repository, { isOnline: () => false });
  await assert.rejects(
    () => engine.commitMutation('note', 'delete', 'note-1', null),
    /must be online/,
  );
  assert.equal(await repository.getNote('note-1'), null);
});

test('creates an encrypted version-aware snapshot and advances local sync metadata', async () => {
  const repository = await createRepository();
  const note = await repository.createNote({ title: 'Checkpoint', body: '', isPinned: false, tags: [] });
  await repository.saveLocalSyncAccountState({
    accountId: 'account-1', deviceId: 'device-1', deviceRole: 'primary_mobile',
    googleUserId: 'google-1', googleEmail: 'writer@example.com', devicePublicKey: '{}',
    recoveryKeyDriveFileId: 'key-1', latestSnapshotDriveFileId: 'snapshot-1',
    latestSnapshotSequence: 2, currentSyncSequence: 2, linkedAt: 1,
  });
  const device: SyncDevice = {
    id: 'device-1', accountId: 'account-1', role: 'primary_mobile', publicKey: '{}',
    displayName: 'Phone', platform: 'android', createdAt: '', lastSeenAt: '',
    revokedAt: null, replacedByDeviceId: null,
  };
  const rootKey = new Uint8Array(32);
  let uploadedBytes = new Uint8Array();
  const controlPlane = {
    getDeviceStatus: async () => device,
    listSyncObjectsAfter: async () => [],
    updateDeviceCursor: async () => ({}),
    lookupCurrentGoogleAccount: async () => ({
      id: 'account-1', googleUserId: 'google-1', googleEmail: 'writer@example.com', createdAt: '',
      activePrimaryDeviceId: 'device-1', currentSyncSequence: 2, currentSnapshotSequence: 2,
      recoveryConfigured: true,
    }),
    commitSyncObject: async (input: any): Promise<SyncObjectMetadata> => ({
      id: 'snapshot-object-3', accountId: 'account-1', sequence: 3, driveFileId: input.driveFileId,
      objectKind: 'snapshot', sha256: input.sha256, sizeBytes: input.sizeBytes,
      createdByDeviceId: 'device-1', createdAt: '',
    }),
  } as unknown as SupabaseControlPlaneClient;
  const engine = new EventSyncEngine(repository, {
    isOnline: () => true,
    now: () => 1,
    loadSecrets: async () => ({
      version: 1, accountId: 'account-1', accountRootKey: rootKey, devicePrivateKeyJwk: '{}',
      supabaseSession: { accessToken: 'supabase', refreshToken: 'refresh', expiresAt: 2_000_000_000 },
    }),
    restoreGoogleSession: async () => ({
      userId: 'google-1', email: 'writer@example.com', displayName: null, accessToken: 'drive',
    }),
    createControlPlane: () => controlPlane,
    upload: async input => { uploadedBytes = input.bytes; return { id: 'snapshot-drive-3' }; },
    maintenance: async () => ({
      objectsToRetire: [],
      snapshotsToRetire: [],
      eventsToRetire: [],
      mediaToRetire: [],
      driveFilesToDelete: [],
    }),
  });

  const committed = await engine.createSnapshot();
  const decrypted = await decryptSyncPayload(rootKey, uploadedBytes);
  const parsed = parseRepositorySnapshotPayload(decrypted.payload, 'account-1');

  assert.equal(committed?.sequence, 3);
  assert.equal(parsed.baseSequence, 2);
  assert.equal(parsed.snapshot.notes[0]?.id, note.id);
  assert.equal((await repository.getLocalSyncAccountState())?.latestSnapshotSequence, 3);
});

test('forced snapshot refreshes partitioned restore manifest for companion pairing', async () => {
  const repository = await createRepository();
  const entry = await repository.createEntry({
    diaryId: 'diary-default',
    date: '2026-07-11',
    title: 'Visible after repair',
    body: '',
    moodName: 'Calm',
    moodEmoji: '',
    tags: [],
    photoUris: [],
  });
  await repository.saveLocalSyncAccountState({
    accountId: 'account-1', deviceId: 'device-1', deviceRole: 'primary_mobile',
    googleUserId: 'google-1', googleEmail: 'writer@example.com', devicePublicKey: '{}',
    recoveryKeyDriveFileId: 'key-1', latestSnapshotDriveFileId: 'snapshot-1',
    latestSnapshotSequence: 8, currentSyncSequence: 20, keyEpoch: 4,
    partitionedSyncEnabled: true, latestManifestDriveFileId: 'old-manifest',
    latestManifestSequence: 12, linkedAt: 1,
  });
  const device: SyncDevice = {
    id: 'device-1', accountId: 'account-1', role: 'primary_mobile', publicKey: '{}',
    displayName: 'Phone', platform: 'android', createdAt: '', lastSeenAt: '',
    revokedAt: null, replacedByDeviceId: null,
  };
  const rootKey = crypto.getRandomValues(new Uint8Array(32));
  const uploaded = new Map<string, Uint8Array>();
  const committedInputs: any[] = [];
  let sequence = 20;
  let lastCursorSequence = 0;
  let uploadCount = 0;
  const controlPlane = {
    getDeviceStatus: async () => device,
    listSyncObjectsAfter: async () => [],
    updateDeviceCursor: async (input: any) => {
      lastCursorSequence = input.lastAppliedSequence;
      return {};
    },
    commitSyncObject: async (input: any): Promise<SyncObjectMetadata> => {
      committedInputs.push(input);
      sequence += 1;
      return {
        id: `object-${sequence}`, accountId: 'account-1', sequence, driveFileId: input.driveFileId,
        objectKind: input.objectKind, sha256: input.sha256, sizeBytes: input.sizeBytes,
        createdByDeviceId: 'device-1', createdAt: '', partitionKey: input.partitionKey,
        affectedPartitionKeys: input.affectedPartitionKeys || [], operationId: input.operationId,
        keyEpoch: input.keyEpoch,
      };
    },
  } as unknown as SupabaseControlPlaneClient;
  const engine = new EventSyncEngine(repository, {
    isOnline: () => true,
    now: () => Date.parse('2026-07-11T00:00:00.000Z'),
    loadSecrets: async () => ({
      version: 1, accountId: 'account-1', accountRootKey: rootKey,
      accountRootKeys: { 4: rootKey },
      devicePrivateKeyJwk: '{}',
      supabaseSession: { accessToken: 'supabase', refreshToken: 'refresh', expiresAt: 2_000_000_000 },
    }),
    restoreGoogleSession: async () => ({
      userId: 'google-1', email: 'writer@example.com', displayName: null, accessToken: 'drive',
    }),
    createControlPlane: () => controlPlane,
    upload: async input => {
      uploadCount += 1;
      const id = `drive-${input.objectKind}-${uploadCount}`;
      uploaded.set(id, input.bytes);
      return { id };
    },
    maintenance: async () => ({
      objectsToRetire: [],
      snapshotsToRetire: [],
      eventsToRetire: [],
      mediaToRetire: [],
      driveFilesToDelete: [],
    }),
  });

  const manifestObject = await engine.createSnapshot();

  assert.equal(manifestObject?.objectKind, 'manifest');
  assert.ok(committedInputs.some(input => input.objectKind === 'partition_snapshot'));
  assert.equal(committedInputs.at(-1).objectKind, 'manifest');
  assert.match(committedInputs.at(-1).operationId, /^partition-refresh:account-1:4:/);
  assert.equal(committedInputs.filter(input => input.objectKind === 'snapshot').length, 0);
  assert.equal(lastCursorSequence, manifestObject?.sequence);

  const decryptedManifest = await decryptSyncPayload(rootKey, uploaded.get(manifestObject!.driveFileId)!);
  const parsedManifest = parsePartitionManifestPayload(decryptedManifest.payload, 'account-1');
  const entryPartition = parsedManifest.partitions.find(partition => partition.partitionKey === 'month:2026-07');
  assert.equal(entryPartition?.entryCount, 1);
  assert.equal(entryPartition?.latestSnapshotDriveFileId?.startsWith('drive-partition_snapshot-'), true);
  assert.equal((await repository.getLocalSyncAccountState())?.latestManifestDriveFileId, manifestObject?.driveFileId);
  assert.equal((await repository.getEntry(entry.id))?.title, 'Visible after repair');
});

test('commits encrypted media before its entry event and hydrates it on another runtime', async () => {
  const repository = await createRepository();
  await repository.saveLocalSyncAccountState({
    accountId: 'account-1', deviceId: 'device-1', deviceRole: 'primary_mobile',
    googleUserId: 'google-1', googleEmail: 'writer@example.com', devicePublicKey: '{}',
    recoveryKeyDriveFileId: 'key-1', latestSnapshotDriveFileId: 'snapshot-1',
    latestSnapshotSequence: 2, currentSyncSequence: 2, linkedAt: 1,
  });
  const device: SyncDevice = {
    id: 'device-1', accountId: 'account-1', role: 'primary_mobile', publicKey: '{}',
    displayName: 'Phone', platform: 'android', createdAt: '', lastSeenAt: '',
    revokedAt: null, replacedByDeviceId: null,
  };
  const rootKey = new Uint8Array(32);
  const uploads: Array<{ kind: string; bytes: Uint8Array; id: string; appProperties?: Record<string, string> }> = [];
  let batchKinds: string[] = [];
  let sequence = 2;
  const controlPlane = {
    getDeviceStatus: async () => device,
    listSyncObjectsAfter: async () => [],
    updateDeviceCursor: async () => ({}),
    commitSyncBatch: async (input: any): Promise<SyncObjectMetadata[]> => {
      batchKinds = input.objects.map((object: any) => object.objectKind);
      return input.objects.map((object: any) => {
        sequence += 1;
        return {
          id: `object-${sequence}`, accountId: 'account-1', sequence, driveFileId: object.driveFileId,
          objectKind: object.objectKind, sha256: object.sha256, sizeBytes: object.sizeBytes,
          createdByDeviceId: 'device-1', createdAt: '',
          recordType: object.objectKind === 'event' ? input.recordType : null,
          recordId: object.objectKind === 'event' ? input.recordId : null,
          baseRecordVersion: object.objectKind === 'event' ? input.baseRecordVersion : null,
          recordVersion: object.objectKind === 'event' ? 1 : null,
          affectedRecords: object.objectKind === 'event' ? [] : undefined,
          partitionKey: object.partitionKey,
          operationId: input.operationId,
        };
      });
    },
  } as unknown as SupabaseControlPlaneClient;
  const dependencies = {
    isOnline: () => true,
    now: () => 1,
    loadSecrets: async () => ({
      version: 1 as const, accountId: 'account-1', accountRootKey: rootKey, devicePrivateKeyJwk: '{}',
      supabaseSession: { accessToken: 'supabase', refreshToken: 'refresh', expiresAt: 2_000_000_000 },
    }),
    restoreGoogleSession: async () => ({
      userId: 'google-1', email: 'writer@example.com', displayName: null, accessToken: 'drive',
    }),
    createControlPlane: () => controlPlane,
    createThumbnail: async () => ({ bytes: new TextEncoder().encode('thumb'), mimeType: 'image/jpeg' }),
    upload: async (input: any) => {
      const id = `drive-${input.objectKind}-${uploads.length + 1}`;
      uploads.push({ kind: input.objectKind, bytes: input.bytes, id, appProperties: input.appProperties });
      return { id };
    },
  };
  const engine = new EventSyncEngine(repository, dependencies);
  const photoDataUri = 'data:image/png;base64,aGVsbG8=';
  const secondPhotoDataUri = 'data:image/png;base64,d29ybGQ=';
  const entry = {
    id: 'entry-media', diaryId: 'diary-default', date: '2026-07-06', title: 'Photo', body: '',
    moodName: 'Calm', moodEmoji: '', tags: [], photoUris: [photoDataUri, secondPhotoDataUri], photoCount: 2,
    wordCount: 0, createdAt: 1, updatedAt: 1,
  };

  await engine.commitMutation('entry', 'upsert', entry.id, entry);

  assert.deepEqual(uploads.map(upload => upload.kind), ['media', 'thumbnail', 'media', 'thumbnail', 'event']);
  assert.equal(uploads[0].appProperties?.mediaKind, 'image');
  assert.equal(uploads[1].appProperties?.mediaKind, 'image');
  assert.deepEqual(batchKinds, ['media', 'thumbnail', 'media', 'thumbnail', 'event']);
  const stored = await repository.getEntry(entry.id);
  const reference = stored?.photoUris[0] || '';
  const parsedReference = parseSyncMediaReference(reference);
  assert.equal(parsedReference?.mediaId.length, 36);
  assert.equal(parsedReference?.driveFileId, 'drive-media-1');
  assert.equal(parseSyncMediaReference(stored?.photoUris[1])?.driveFileId, 'drive-media-3');
  const decryptedMedia = await decryptSyncPayload(rootKey, uploads[0].bytes);
  assert.equal(new TextDecoder().decode(decodeSyncMediaPayload(decryptedMedia.payload).bytes), 'hello');
  const decryptedThumbnail = await decryptSyncPayload(rootKey, uploads[1].bytes);
  assert.equal(decryptedThumbnail.objectKind, 'thumbnail');
  assert.equal(new TextDecoder().decode(decodeSyncThumbnailPayload(decryptedThumbnail.payload).bytes), 'thumb');
  const decryptedSecondMedia = await decryptSyncPayload(rootKey, uploads[2].bytes);
  assert.equal(new TextDecoder().decode(decodeSyncMediaPayload(decryptedSecondMedia.payload).bytes), 'world');

  const pointer = await repository.getSyncMediaPointerByDriveFileId('drive-media-1');
  assert.equal(pointer?.sequence, 3);
  assert.equal(pointer?.thumbnailDriveFileId, 'drive-thumbnail-2');
  await repository.saveSyncMediaPointer({ ...pointer!, localUri: 'http://localhost/_capacitor_file_/photo.jpg' });
  const secondPointer = await repository.getSyncMediaPointerByDriveFileId('drive-media-3');
  assert.equal(secondPointer?.sequence, 5);
  assert.equal(secondPointer?.thumbnailDriveFileId, 'drive-thumbnail-4');
  await repository.saveSyncMediaPointer({ ...secondPointer!, localUri: undefined });
  const freshEngine = new EventSyncEngine(repository, {
    ...dependencies,
    download: async (_session, fileId) => uploads.find(upload => upload.id === fileId)!.bytes,
  });
  const hydrated = await freshEngine.hydrateEntries([stored!]);
  assert.equal(hydrated[0].photoUris[0], photoDataUri);
  assert.equal(hydrated[0].photoUris[1], secondPhotoDataUri);
  assert.equal((await repository.getSyncMediaPointerByDriveFileId('drive-media-1'))?.localUri, photoDataUri);
});

test('preserves a stale note edit as a recovered copy after pulling the winner', async () => {
  const repository = await createRepository();
  await repository.saveLocalSyncAccountState({
    accountId: 'account-1', deviceId: 'device-1', deviceRole: 'primary_mobile',
    googleUserId: 'google-1', googleEmail: 'writer@example.com', devicePublicKey: '{}',
    recoveryKeyDriveFileId: 'key-1', latestSnapshotDriveFileId: 'snapshot-1',
    currentSyncSequence: 2, linkedAt: 1,
  });
  const device: SyncDevice = {
    id: 'device-1', accountId: 'account-1', role: 'primary_mobile', publicKey: '{}',
    displayName: 'Phone', platform: 'android', createdAt: '', lastSeenAt: '',
    revokedAt: null, replacedByDeviceId: null,
  };
  let commitAttempt = 0;
  const controlPlane = {
    getDeviceStatus: async () => device,
    listSyncObjectsAfter: async () => [],
    updateDeviceCursor: async () => ({}),
    commitSyncObject: async (input: any): Promise<SyncObjectMetadata> => {
      commitAttempt += 1;
      if (commitAttempt === 1) {
        throw new SupabaseControlPlaneError('stale_record_version', 409, {});
      }
      return {
        id: 'recovered-object', accountId: 'account-1', sequence: 3,
        driveFileId: input.driveFileId, objectKind: 'event', sha256: input.sha256,
        sizeBytes: input.sizeBytes, createdByDeviceId: 'device-1', createdAt: '',
        recordType: 'note', recordId: input.recordId, baseRecordVersion: 0, recordVersion: 1,
      };
    },
  } as unknown as SupabaseControlPlaneClient;
  const engine = new EventSyncEngine(repository, {
    isOnline: () => true,
    now: () => 10,
    loadSecrets: async () => ({
      version: 1, accountId: 'account-1', accountRootKey: new Uint8Array(32),
      devicePrivateKeyJwk: '{}',
      supabaseSession: { accessToken: 'supabase', refreshToken: 'refresh', expiresAt: 2_000_000_000 },
    }),
    restoreGoogleSession: async () => ({
      userId: 'google-1', email: 'writer@example.com', displayName: null, accessToken: 'drive',
    }),
    createControlPlane: () => controlPlane,
    upload: async () => ({ id: `drive-${commitAttempt + 1}` }),
  });
  const staleNote = {
    id: 'note-1', title: 'My edit', body: 'Keep this', isPinned: false,
    tags: [], createdAt: 1, updatedAt: 2,
  };

  await assert.rejects(
    () => engine.commitMutation('note', 'upsert', staleNote.id, staleNote),
    (error: unknown) => error instanceof SyncConflictError && Boolean(error.recoveredRecordId),
  );

  const notes = await repository.listNotes();
  assert.equal(notes.length, 1);
  assert.equal(notes[0].title, 'My edit (Recovered copy)');
  assert.equal(notes[0].body, 'Keep this');
});

test('preserves local-first outbox conflicts and queues a recovered copy', async () => {
  const repository = await createRepository();
  await repository.saveLocalSyncAccountState({
    accountId: 'account-1', deviceId: 'device-1', deviceRole: 'primary_mobile',
    googleUserId: 'google-1', googleEmail: 'writer@example.com', devicePublicKey: '{}',
    recoveryKeyDriveFileId: 'key-1', latestSnapshotDriveFileId: 'snapshot-1',
    currentSyncSequence: 2, linkedAt: 1,
  });
  const device: SyncDevice = {
    id: 'device-1', accountId: 'account-1', role: 'primary_mobile', publicKey: '{}',
    displayName: 'Phone', platform: 'android', createdAt: '', lastSeenAt: '',
    revokedAt: null, replacedByDeviceId: null,
  };
  const controlPlane = {
    getDeviceStatus: async () => device,
    listSyncObjectsAfter: async () => [],
    updateDeviceCursor: async () => ({}),
    commitSyncObject: async () => {
      throw new SupabaseControlPlaneError('stale_record_version', 409, {});
    },
  } as unknown as SupabaseControlPlaneClient;
  const engine = new EventSyncEngine(repository, {
    isOnline: () => true,
    now: () => 10,
    loadSecrets: async () => ({
      version: 1, accountId: 'account-1', accountRootKey: new Uint8Array(32),
      devicePrivateKeyJwk: '{}',
      supabaseSession: { accessToken: 'supabase', refreshToken: 'refresh', expiresAt: 2_000_000_000 },
    }),
    restoreGoogleSession: async () => ({
      userId: 'google-1', email: 'writer@example.com', displayName: null, accessToken: 'drive',
    }),
    createControlPlane: () => controlPlane,
    upload: async () => ({ id: 'drive-conflict' }),
  });
  engine.requestOutboxFlush = () => undefined;
  const note = {
    id: 'note-local-conflict',
    title: 'Local edit',
    body: 'Preserve this',
    isPinned: false,
    tags: [],
    createdAt: 1,
    updatedAt: 2,
  };

  await repository.applyLocalMutationWithOutbox({
    operationId: 'operation-local-conflict',
    recordType: 'note',
    recordId: note.id,
    operation: 'upsert',
    account: (await repository.getLocalSyncAccountState())!,
    localPayload: note,
  });

  await engine.flushPendingOutbox();

  const operations = await repository.listSyncOutboxOperations();
  const failedOriginal = operations.find(operation => operation.operationId === 'operation-local-conflict');
  const recovered = operations.find(operation => operation.recordId.startsWith('note-recovered-'));
  const notes = await repository.listNotes();

  assert.equal(failedOriginal?.state, 'failed');
  assert.equal(failedOriginal?.nextRetryAt, Number.MAX_SAFE_INTEGER);
  assert.deepEqual(failedOriginal?.payload, note);
  assert.equal(recovered?.state, 'prepared');
  assert.equal(recovered?.localApplied, true);
  assert.equal(notes.length, 2);
  assert.ok(notes.some(stored => stored.id === note.id && stored.title === 'Local edit'));
  assert.ok(notes.some(stored => stored.title === 'Local edit (Recovered copy)'));
  const status = await repository.getSyncStatusSummary();
  assert.equal(status.failedOperationCount, 1);
  assert.equal(status.conflictCount, 1);
});

test('primary devices lazily migrate to partitioned sync when no manifest exists', async () => {
  const repository = await createRepository();
  await repository.createEntry({
    diaryId: 'diary-default',
    date: '2026-07-06',
    title: 'Partition me',
    body: '',
    moodName: 'Calm',
    moodEmoji: '',
    tags: [],
    photoUris: [],
  });
  await repository.saveLocalSyncAccountState({
    accountId: 'account-1', deviceId: 'device-1', deviceRole: 'primary_mobile',
    googleUserId: 'google-1', googleEmail: 'writer@example.com', devicePublicKey: '{}',
    recoveryKeyDriveFileId: 'key-1', latestSnapshotDriveFileId: 'snapshot-1',
    latestSnapshotSequence: 2, currentSyncSequence: 2, linkedAt: 1,
  });
  const device: SyncDevice = {
    id: 'device-1', accountId: 'account-1', role: 'primary_mobile', publicKey: '{}',
    displayName: 'Phone', platform: 'android', createdAt: '', lastSeenAt: '',
    revokedAt: null, replacedByDeviceId: null,
  };
  const committedKinds: string[] = [];
  let sequence = 2;
  const controlPlane = {
    getDeviceStatus: async () => device,
    listSyncObjectsAfter: async () => [],
    updateDeviceCursor: async () => ({}),
    getLatestRestoreManifest: async () => ({
      manifestObject: null,
      coreSnapshotObject: null,
      currentSyncSequence: sequence,
      keyEpoch: 1,
    }),
    commitSyncObject: async (input: any): Promise<SyncObjectMetadata> => {
      committedKinds.push(input.objectKind);
      sequence += 1;
      return {
        id: `object-${sequence}`, accountId: 'account-1', sequence, driveFileId: input.driveFileId,
        objectKind: input.objectKind, sha256: input.sha256, sizeBytes: input.sizeBytes,
        createdByDeviceId: 'device-1', createdAt: '', partitionKey: input.partitionKey,
      };
    },
  } as unknown as SupabaseControlPlaneClient;
  const engine = new EventSyncEngine(repository, {
    isOnline: () => true,
    now: () => 1,
    loadSecrets: async () => ({
      version: 1, accountId: 'account-1', accountRootKey: new Uint8Array(32),
      devicePrivateKeyJwk: '{}',
      supabaseSession: { accessToken: 'supabase-token', refreshToken: 'refresh', expiresAt: 2_000_000_000 },
    }),
    restoreGoogleSession: async () => ({
      userId: 'google-1', email: 'writer@example.com', displayName: null, accessToken: 'drive-token',
    }),
    createControlPlane: () => controlPlane,
    upload: async input => ({ id: `drive-${input.objectKind}-${committedKinds.length + 1}` }),
  });

  assert.equal(await engine.ensurePartitionedSync(), true);

  assert.ok(committedKinds.includes('partition_snapshot'));
  assert.equal(committedKinds.at(-1), 'manifest');
  assert.equal((await repository.getLocalSyncAccountState())?.partitionedSyncEnabled, true);
});

test('partitioned sync pulls hydrated archive partitions by partition cursor', async () => {
  const repository = await createRepository();
  await repository.saveLocalSyncAccountState({
    accountId: 'account-1', deviceId: 'device-1', deviceRole: 'primary_mobile',
    googleUserId: 'google-1', googleEmail: 'writer@example.com', devicePublicKey: '{}',
    recoveryKeyDriveFileId: 'key-1', latestSnapshotDriveFileId: 'snapshot-1',
    currentSyncSequence: 50, partitionedSyncEnabled: true, latestManifestDriveFileId: 'manifest-1',
    linkedAt: 1,
  });
  await repository.markPartitionHydrated('month:2026-07', 4);
  const device: SyncDevice = {
    id: 'device-1', accountId: 'account-1', role: 'primary_mobile', publicKey: '{}',
    displayName: 'Phone', platform: 'android', createdAt: '', lastSeenAt: '',
    revokedAt: null, replacedByDeviceId: null,
  };
  const rootKey = new Uint8Array(32);
  const note = { id: 'note-partition', title: 'From archive pull', body: '', isPinned: false, tags: [], createdAt: Date.parse('2026-07-04T00:00:00.000Z'), updatedAt: 1 };
  const event = createSyncDomainEvent({
    accountId: 'account-1', deviceId: 'device-2', recordType: 'note', operation: 'upsert',
    recordId: note.id, baseRecordVersion: 0, payload: note,
  });
  const encrypted = await encryptSyncPayload(rootKey, 'event', encodeSyncDomainEvent(event));
  let partitionCursorUpdated = 0;
  const controlPlane = {
    getDeviceStatus: async () => device,
    listPartitionObjectsAfter: async (_deviceId: string, partitionKey: string, afterSequence: number) => (
      partitionKey === 'month:2026-07' && afterSequence === 4
        ? [{
            id: 'object-5', accountId: 'account-1', sequence: 5, driveFileId: 'drive-event-5',
            objectKind: 'event', sha256: encrypted.sha256, sizeBytes: encrypted.bytes.byteLength,
            createdByDeviceId: 'device-2', createdAt: '', recordType: 'note', recordId: note.id,
            baseRecordVersion: 0, recordVersion: 1, partitionKey,
          }]
        : []
    ),
    updatePartitionCursor: async (input: any) => { partitionCursorUpdated = input.lastAppliedSequence; return {}; },
    updateDeviceCursor: async () => ({}),
  } as unknown as SupabaseControlPlaneClient;
  const engine = new EventSyncEngine(repository, {
    isOnline: () => true,
    now: () => Date.parse('2026-07-06T00:00:00.000Z'),
    loadSecrets: async () => ({
      version: 1, accountId: 'account-1', accountRootKey: rootKey, devicePrivateKeyJwk: '{}',
      supabaseSession: { accessToken: 'supabase-token', refreshToken: 'refresh', expiresAt: 2_000_000_000 },
    }),
    restoreGoogleSession: async () => ({
      userId: 'google-1', email: 'writer@example.com', displayName: null, accessToken: 'drive-token',
    }),
    createControlPlane: () => controlPlane,
    download: async () => encrypted.bytes,
    maintenance: async () => ({
      objectsToRetire: [],
      snapshotsToRetire: [],
      eventsToRetire: [],
      mediaToRetire: [],
      driveFilesToDelete: [],
    }),
  });

  await engine.pullPending();

  assert.equal((await repository.getNote(note.id))?.title, 'From archive pull');
  assert.equal(partitionCursorUpdated, 5);
  assert.equal((await repository.getLocalSyncAccountState())?.currentSyncSequence, 50);
});

test('partitioned sync repairs an untracked recent month before pulling companion events', async () => {
  const repository = await createRepository();
  await repository.createEntry({
    diaryId: 'diary-default', date: '2026-07-05', title: 'From phone', body: '',
    moodName: 'Calm', moodEmoji: '', tags: [], photoUris: [],
  });
  await repository.saveLocalSyncAccountState({
    accountId: 'account-1', deviceId: 'device-1', deviceRole: 'primary_mobile',
    googleUserId: 'google-1', googleEmail: 'writer@example.com', devicePublicKey: '{}',
    recoveryKeyDriveFileId: 'key-1', latestSnapshotDriveFileId: 'snapshot-1',
    currentSyncSequence: 3, partitionedSyncEnabled: true, latestManifestDriveFileId: 'manifest-1',
    linkedAt: 1,
  });
  await repository.markPartitionHydrated('core', 2);

  const device: SyncDevice = {
    id: 'device-1', accountId: 'account-1', role: 'primary_mobile', publicKey: '{}',
    displayName: 'Phone', platform: 'android', createdAt: '', lastSeenAt: '',
    revokedAt: null, replacedByDeviceId: null,
  };
  const rootKey = new Uint8Array(32);
  const companionEntry = {
    id: 'entry-from-web', diaryId: 'diary-default', date: '2026-07-06', title: 'From web', body: '',
    moodName: 'Calm', moodEmoji: '', tags: [], photoUris: [], photoCount: 0, wordCount: 0,
    createdAt: 4, updatedAt: 4,
  };
  const event = createSyncDomainEvent({
    accountId: 'account-1', deviceId: 'device-2', recordType: 'entry', operation: 'upsert',
    recordId: companionEntry.id, baseRecordVersion: 0, payload: companionEntry,
  });
  const encrypted = await encryptSyncPayload(rootKey, 'event', encodeSyncDomainEvent(event));
  const partitionCursorUpdates: number[] = [];
  const controlPlane = {
    getDeviceStatus: async () => device,
    listPartitionHeads: async () => [{
      accountId: 'account-1', partitionKey: 'month:2026-07', latestSnapshotSequence: 0,
      latestEventSequence: 4, updatedAt: '',
    }],
    listPartitionObjectsAfter: async (_deviceId: string, partitionKey: string, afterSequence: number) => (
      partitionKey === 'month:2026-07' && afterSequence === 3
        ? [{
            id: 'object-4', accountId: 'account-1', sequence: 4, driveFileId: 'drive-event-4',
            objectKind: 'event', sha256: encrypted.sha256, sizeBytes: encrypted.bytes.byteLength,
            createdByDeviceId: 'device-2', createdAt: '', recordType: 'entry', recordId: companionEntry.id,
            baseRecordVersion: 0, recordVersion: 1, partitionKey,
          }]
        : []
    ),
    updatePartitionCursor: async (input: any) => {
      if (input.partitionKey === 'month:2026-07') partitionCursorUpdates.push(input.lastAppliedSequence);
      return {};
    },
    updateDeviceCursor: async () => ({}),
  } as unknown as SupabaseControlPlaneClient;
  const engine = new EventSyncEngine(repository, {
    isOnline: () => true,
    now: () => Date.parse('2026-07-06T00:00:00.000Z'),
    loadSecrets: async () => ({
      version: 1, accountId: 'account-1', accountRootKey: rootKey, devicePrivateKeyJwk: '{}',
      supabaseSession: { accessToken: 'supabase-token', refreshToken: 'refresh', expiresAt: 2_000_000_000 },
    }),
    restoreGoogleSession: async () => ({
      userId: 'google-1', email: 'writer@example.com', displayName: null, accessToken: 'drive-token',
    }),
    createControlPlane: () => controlPlane,
    download: async () => encrypted.bytes,
    maintenance: async () => ({
      objectsToRetire: [], snapshotsToRetire: [], eventsToRetire: [], mediaToRetire: [], driveFilesToDelete: [],
    }),
  });

  await engine.pullPending();

  assert.equal((await repository.getEntry(companionEntry.id))?.title, 'From web');
  assert.deepEqual(partitionCursorUpdates, [3, 4]);
  assert.equal((await repository.getPartitionHydrationState('month:2026-07')).lastAppliedSequence, 4);
});

test('partitioned companions process new epoch key packages before partition events', async () => {
  const repository = await createRepository();
  const deviceKeys = await generateDeviceKeyPair();
  await repository.saveLocalSyncAccountState({
    accountId: 'account-1', deviceId: 'device-1', deviceRole: 'web_companion',
    googleUserId: 'google-1', googleEmail: 'writer@example.com', devicePublicKey: deviceKeys.publicKey,
    recoveryKeyDriveFileId: 'key-1', latestSnapshotDriveFileId: 'snapshot-1',
    currentSyncSequence: 10, keyEpoch: 1, partitionedSyncEnabled: true, latestManifestDriveFileId: 'manifest-1',
    linkedAt: 1,
  });
  await repository.markPartitionHydrated('month:2026-07', 10);
  const device: SyncDevice = {
    id: 'device-1', accountId: 'account-1', role: 'web_companion', publicKey: deviceKeys.publicKey,
    displayName: 'Browser', platform: 'web', createdAt: '', lastSeenAt: '',
    revokedAt: null, replacedByDeviceId: null,
  };
  const epochOneRootKey = new Uint8Array(32);
  const epochTwoRootKey = new Uint8Array(32).fill(7);
  const keyPackageBytes = encodeCompanionKeyPackage(await wrapRootKeyForCompanion(
    epochTwoRootKey,
    'account-1',
    deviceKeys.publicKey,
    { keyEpoch: 2 },
  ));
  const note = {
    id: 'note-epoch-2', title: 'After rotation', body: '', isPinned: false, tags: [],
    createdAt: Date.parse('2026-07-04T00:00:00.000Z'), updatedAt: 1,
  };
  const event = createSyncDomainEvent({
    accountId: 'account-1', deviceId: 'device-2', recordType: 'note', operation: 'upsert',
    recordId: note.id, baseRecordVersion: 0, payload: note,
  });
  const encryptedEvent = await encryptSyncPayload(epochTwoRootKey, 'event', encodeSyncDomainEvent(event), { keyEpoch: 2 });
  let savedSecrets: SyncSecrets = {
    version: 1 as const,
    accountId: 'account-1',
    accountRootKey: epochOneRootKey,
    accountRootKeys: { 1: epochOneRootKey },
    devicePrivateKeyJwk: deviceKeys.privateKeyJwk,
    supabaseSession: { accessToken: 'supabase-token', refreshToken: 'refresh', expiresAt: 2_000_000_000 },
  };
  const controlPlane = {
    getDeviceStatus: async () => device,
    listSyncObjectsAfter: async (_deviceId: string, afterSequence: number) => (
      afterSequence === 10
        ? [{
            id: 'key-package-11', accountId: 'account-1', sequence: 11, driveFileId: 'drive-key-package-11',
            objectKind: 'key_package', sha256: await sha256Hex(keyPackageBytes), sizeBytes: keyPackageBytes.byteLength,
            createdByDeviceId: 'device-primary', createdAt: '', keyEpoch: 2,
          }]
        : []
    ),
    listPartitionObjectsAfter: async (_deviceId: string, partitionKey: string, afterSequence: number) => (
      partitionKey === 'month:2026-07' && afterSequence === 10
        ? [{
            id: 'object-12', accountId: 'account-1', sequence: 12, driveFileId: 'drive-event-12',
            objectKind: 'event', sha256: encryptedEvent.sha256, sizeBytes: encryptedEvent.bytes.byteLength,
            createdByDeviceId: 'device-2', createdAt: '', recordType: 'note', recordId: note.id,
            baseRecordVersion: 0, recordVersion: 1, partitionKey, keyEpoch: 2,
          }]
        : []
    ),
    updatePartitionCursor: async () => ({}),
    updateDeviceCursor: async () => ({}),
  } as unknown as SupabaseControlPlaneClient;
  const engine = new EventSyncEngine(repository, {
    isOnline: () => true,
    now: () => Date.parse('2026-07-06T00:00:00.000Z'),
    loadSecrets: async () => savedSecrets,
    saveSecrets: async secrets => { savedSecrets = secrets; },
    restoreGoogleSession: async () => ({
      userId: 'google-1', email: 'writer@example.com', displayName: null, accessToken: 'drive-token',
    }),
    createControlPlane: () => controlPlane,
    download: async (_session, fileId) => (fileId === 'drive-key-package-11' ? keyPackageBytes : encryptedEvent.bytes),
    maintenance: async () => ({
      objectsToRetire: [],
      snapshotsToRetire: [],
      eventsToRetire: [],
      mediaToRetire: [],
      driveFilesToDelete: [],
    }),
  });

  await engine.pullPending();

  assert.deepEqual(savedSecrets.accountRootKeys?.[2], epochTwoRootKey);
  assert.equal((await repository.getLocalSyncAccountState())?.keyEpoch, 2);
  assert.equal((await repository.getNote(note.id))?.title, 'After rotation');
  assert.equal((await repository.getPartitionHydrationState('month:2026-07')).lastAppliedSequence, 12);
});

test('background archive hydration imports one available month when policy allows', async () => {
  const repository = await createRepository();
  await repository.saveLocalSyncAccountState({
    accountId: 'account-1', deviceId: 'device-1', deviceRole: 'primary_mobile',
    googleUserId: 'google-1', googleEmail: 'writer@example.com', devicePublicKey: '{}',
    recoveryKeyDriveFileId: 'key-1', latestSnapshotDriveFileId: 'snapshot-1',
    currentSyncSequence: 20, partitionedSyncEnabled: true, latestManifestDriveFileId: 'drive-manifest',
    linkedAt: 1,
  });
  await repository.markPartitionAvailable('month:2021-03', 6);
  const rootKey = new Uint8Array(32);
  const oldNote = {
    id: 'note-old-month',
    title: 'Old March memory',
    body: '',
    isPinned: false,
    tags: [],
    createdAt: Date.parse('2021-03-04T00:00:00.000Z'),
    updatedAt: 1,
  };
  const snapshot = { ...(await repository.exportSnapshot()), notes: [oldNote] };
  const encryptedPartition = await encryptSyncPayload(
    rootKey,
    'partition_snapshot',
    encodePartitionSnapshotPayload(snapshot, 'account-1', 'month:2021-03', 6),
  );
  const manifest = buildPartitionManifest({
    accountId: 'account-1',
    snapshot,
    now: new Date('2026-07-06T00:00:00.000Z'),
    snapshotMetadata: {
      'month:2021-03': {
        latestSnapshotSequence: 6,
        latestSnapshotDriveFileId: 'drive-partition-old',
        latestSnapshotSha256: encryptedPartition.sha256,
        latestSnapshotSizeBytes: encryptedPartition.bytes.byteLength,
        headSequence: 6,
      },
    },
  });
  const encryptedManifest = await encryptSyncPayload(
    rootKey,
    'manifest',
    encodePartitionManifestPayload(manifest),
  );
  const device: SyncDevice = {
    id: 'device-1', accountId: 'account-1', role: 'primary_mobile', publicKey: '{}',
    displayName: 'Phone', platform: 'android', createdAt: '', lastSeenAt: '',
    revokedAt: null, replacedByDeviceId: null,
  };
  let partitionCursorUpdated = 0;
  const controlPlane = {
    getDeviceStatus: async () => device,
    getLatestRestoreManifest: async () => ({
      manifestObject: {
        id: 'object-manifest', accountId: 'account-1', sequence: 21, driveFileId: 'drive-manifest',
        objectKind: 'manifest', sha256: encryptedManifest.sha256, sizeBytes: encryptedManifest.bytes.byteLength,
        createdByDeviceId: 'device-1', createdAt: '',
      },
      coreSnapshotObject: null,
      currentSyncSequence: 21,
      keyEpoch: 1,
    }),
    getPartitionRestoreBundle: async (_deviceId: string, partitionKeys: string[]) => (
      partitionKeys.includes('month:2021-03')
        ? [{
            partitionKey: 'month:2021-03',
            snapshotObject: {
              id: 'object-partition', accountId: 'account-1', sequence: 6, driveFileId: 'drive-partition-old',
              objectKind: 'partition_snapshot', sha256: encryptedPartition.sha256, sizeBytes: encryptedPartition.bytes.byteLength,
              createdByDeviceId: 'device-1', createdAt: '', partitionKey: 'month:2021-03',
            },
            tailObjects: [],
          }]
        : []
    ),
    updatePartitionCursor: async (input: any) => { partitionCursorUpdated = input.lastAppliedSequence; return {}; },
    updateDeviceCursor: async () => ({}),
  } as unknown as SupabaseControlPlaneClient;
  const engine = new EventSyncEngine(repository, {
    isOnline: () => true,
    now: () => Date.parse('2026-07-06T00:00:00.000Z'),
    loadSecrets: async () => ({
      version: 1, accountId: 'account-1', accountRootKey: rootKey, devicePrivateKeyJwk: '{}',
      supabaseSession: { accessToken: 'supabase-token', refreshToken: 'refresh', expiresAt: 2_000_000_000 },
    }),
    restoreGoogleSession: async () => ({
      userId: 'google-1', email: 'writer@example.com', displayName: null, accessToken: 'drive-token',
    }),
    createControlPlane: () => controlPlane,
    download: async (_session, fileId) => (
      fileId === 'drive-manifest' ? encryptedManifest.bytes : encryptedPartition.bytes
    ),
    getArchiveHydrationPolicyInput: () => ({
      isOnline: true,
      isWifi: true,
      isCharging: true,
      batteryLevel: 0.9,
    }),
  });

  const result = await engine.hydrateBackgroundArchiveOnce();

  assert.deepEqual(result.hydratedPartitionKeys, ['month:2021-03']);
  assert.equal((await repository.getNote(oldNote.id))?.title, 'Old March memory');
  assert.equal((await repository.getPartitionHydrationState('month:2021-03')).status, 'hydrated');
  assert.equal(partitionCursorUpdated, 6);
});

test('background archive hydration skips available months when policy blocks', async () => {
  const repository = await createRepository();
  await repository.saveLocalSyncAccountState({
    accountId: 'account-1', deviceId: 'device-1', deviceRole: 'primary_mobile',
    googleUserId: 'google-1', googleEmail: 'writer@example.com', devicePublicKey: '{}',
    recoveryKeyDriveFileId: 'key-1', latestSnapshotDriveFileId: 'snapshot-1',
    currentSyncSequence: 20, partitionedSyncEnabled: true, latestManifestDriveFileId: 'drive-manifest',
    linkedAt: 1,
  });
  await repository.markPartitionAvailable('month:2021-03', 6);
  let openedControlPlane = false;
  const engine = new EventSyncEngine(repository, {
    isOnline: () => true,
    createControlPlane: () => {
      openedControlPlane = true;
      return {} as SupabaseControlPlaneClient;
    },
    getArchiveHydrationPolicyInput: () => ({
      isOnline: true,
      isWifi: false,
      isCharging: true,
      userAllowedMobileData: false,
    }),
  });

  const result = await engine.hydrateBackgroundArchiveOnce();

  assert.equal(result.decision.reason, 'mobile_data_blocked');
  assert.deepEqual(result.hydratedPartitionKeys, []);
  assert.equal(openedControlPlane, false);
  assert.equal((await repository.getPartitionHydrationState('month:2021-03')).status, 'available');
});

test('background archive hydration backs off failed months until retry time', async () => {
  const repository = await createRepository();
  await repository.saveLocalSyncAccountState({
    accountId: 'account-1', deviceId: 'device-1', deviceRole: 'primary_mobile',
    googleUserId: 'google-1', googleEmail: 'writer@example.com', devicePublicKey: '{}',
    recoveryKeyDriveFileId: 'key-1', latestSnapshotDriveFileId: 'snapshot-1',
    currentSyncSequence: 20, partitionedSyncEnabled: true, latestManifestDriveFileId: 'drive-manifest',
    linkedAt: 1,
  });
  await repository.markPartitionAvailable('month:2021-03', 6);
  await repository.markPartitionHydrationFailed('month:2021-03', 'temporary cloud error');
  let openedControlPlane = false;
  const engine = new EventSyncEngine(repository, {
    isOnline: () => true,
    now: () => 1,
    createControlPlane: () => {
      openedControlPlane = true;
      return {} as SupabaseControlPlaneClient;
    },
    getArchiveHydrationPolicyInput: () => ({
      isOnline: true,
      isWifi: true,
      isCharging: true,
      batteryLevel: 0.9,
    }),
  });

  const result = await engine.hydrateBackgroundArchiveOnce();

  assert.deepEqual(result.hydratedPartitionKeys, []);
  assert.equal(openedControlPlane, false);
  const failed = await repository.getPartitionHydrationState('month:2021-03');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failureCount, 1);
  assert.ok((failed.nextRetryAt || 0) > (failed.failedAt || 0));
});

test('background archive hydration records a failed month only once', async () => {
  const repository = await createRepository();
  await repository.saveLocalSyncAccountState({
    accountId: 'account-1', deviceId: 'device-1', deviceRole: 'primary_mobile',
    googleUserId: 'google-1', googleEmail: 'writer@example.com', devicePublicKey: '{}',
    recoveryKeyDriveFileId: 'key-1', latestSnapshotDriveFileId: 'snapshot-1',
    currentSyncSequence: 20, partitionedSyncEnabled: true, latestManifestDriveFileId: 'drive-manifest',
    linkedAt: 1,
  });
  await repository.markPartitionAvailable('month:2021-03', 6);
  const device: SyncDevice = {
    id: 'device-1', accountId: 'account-1', role: 'primary_mobile', publicKey: '{}',
    displayName: 'Phone', platform: 'android', createdAt: '', lastSeenAt: '',
    revokedAt: null, replacedByDeviceId: null,
  };
  const controlPlane = {
    getDeviceStatus: async () => device,
    getLatestRestoreManifest: async () => ({
      manifestObject: null,
      coreSnapshotObject: null,
      currentSyncSequence: 20,
      keyEpoch: 1,
    }),
  } as unknown as SupabaseControlPlaneClient;
  const engine = new EventSyncEngine(repository, {
    isOnline: () => true,
    now: () => Date.parse('2026-07-06T00:00:00.000Z'),
    loadSecrets: async () => ({
      version: 1, accountId: 'account-1', accountRootKey: new Uint8Array(32), devicePrivateKeyJwk: '{}',
      supabaseSession: { accessToken: 'supabase-token', refreshToken: 'refresh', expiresAt: 2_000_000_000 },
    }),
    restoreGoogleSession: async () => ({
      userId: 'google-1', email: 'writer@example.com', displayName: null, accessToken: 'drive-token',
    }),
    createControlPlane: () => controlPlane,
    getArchiveHydrationPolicyInput: () => ({
      isOnline: true,
      isWifi: true,
      isCharging: true,
      batteryLevel: 0.9,
    }),
  });

  const result = await engine.hydrateBackgroundArchiveOnce();

  assert.deepEqual(result.hydratedPartitionKeys, []);
  const failed = await repository.getPartitionHydrationState('month:2021-03');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failureCount, 1);
});
