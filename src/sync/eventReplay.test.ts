import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryDataStore, createRepository } from './testSupport';
import { createSyncDomainEvent, encodeSyncDomainEvent } from './domainEvents';
import { encryptSyncPayload } from './encryptedSyncObject';
import { replaySyncObjects } from './eventReplay';
import { EventSyncEngine } from './eventSyncEngine';
import { createStableSyncMediaReference, encodeSyncMediaPayload } from './syncMedia';

test('verifies, decrypts, and applies an event tail in sequence order', async () => {
  const repository = await createRepository(new MemoryDataStore());
  const localState = {
    accountId: 'account-1', deviceId: 'device-1', deviceRole: 'primary_mobile' as const,
    googleUserId: 'google-1', googleEmail: 'writer@example.com', devicePublicKey: '{}',
    recoveryKeyDriveFileId: 'key-1', latestSnapshotDriveFileId: 'snapshot-1',
    currentSyncSequence: 2, linkedAt: 1,
  };
  await repository.saveLocalSyncAccountState(localState);
  const rootKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const note = { id: 'note-1', title: 'Synced', body: '', isPinned: false, tags: [], createdAt: 1, updatedAt: 1 };
  const event = createSyncDomainEvent({
    accountId: localState.accountId, deviceId: 'device-2', recordType: 'note', operation: 'upsert',
    recordId: note.id, baseRecordVersion: 0, payload: note,
  });
  const encrypted = await encryptSyncPayload(rootKey, 'event', encodeSyncDomainEvent(event));

  const state = await replaySyncObjects({
    repository,
    localState,
    accountRootKey: rootKey,
    googleSession: { userId: 'google-1', email: 'writer@example.com', displayName: null, accessToken: 'token' },
    objects: [{
      id: 'object-1', accountId: localState.accountId, sequence: 3, driveFileId: 'drive-1',
      objectKind: 'event', sha256: encrypted.sha256, sizeBytes: encrypted.bytes.byteLength,
      createdByDeviceId: 'device-2', createdAt: '2026-07-05T00:00:00.000Z',
      recordType: 'note', recordId: note.id, baseRecordVersion: 0, recordVersion: 1,
    }],
    download: async () => encrypted.bytes,
  });

  assert.equal(state.currentSyncSequence, 3);
  assert.equal((await repository.getNote(note.id))?.title, 'Synced');
});

test('can replay historical partition events without moving the global cursor backwards', async () => {
  const repository = await createRepository(new MemoryDataStore());
  const localState = {
    accountId: 'account-1', deviceId: 'device-1', deviceRole: 'primary_mobile' as const,
    googleUserId: 'google-1', googleEmail: 'writer@example.com', devicePublicKey: '{}',
    recoveryKeyDriveFileId: 'key-1', latestSnapshotDriveFileId: 'snapshot-1',
    currentSyncSequence: 50, linkedAt: 1,
  };
  await repository.saveLocalSyncAccountState(localState);
  const rootKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const note = { id: 'note-old', title: 'Historical', body: '', isPinned: false, tags: [], createdAt: 1, updatedAt: 1 };
  const event = createSyncDomainEvent({
    accountId: localState.accountId, deviceId: 'device-2', recordType: 'note', operation: 'upsert',
    recordId: note.id, baseRecordVersion: 0, payload: note,
  });
  const encrypted = await encryptSyncPayload(rootKey, 'event', encodeSyncDomainEvent(event));

  const state = await replaySyncObjects({
    repository,
    localState,
    accountRootKey: rootKey,
    googleSession: { userId: 'google-1', email: 'writer@example.com', displayName: null, accessToken: 'token' },
    objects: [{
      id: 'object-1', accountId: localState.accountId, sequence: 12, driveFileId: 'drive-1',
      objectKind: 'event', sha256: encrypted.sha256, sizeBytes: encrypted.bytes.byteLength,
      createdByDeviceId: 'device-2', createdAt: '2026-07-05T00:00:00.000Z',
      recordType: 'note', recordId: note.id, baseRecordVersion: 0, recordVersion: 1,
    }],
    download: async () => encrypted.bytes,
    allowHistorical: true,
  });

  assert.equal(state.currentSyncSequence, 50);
  assert.equal((await repository.getLocalSyncAccountState())?.currentSyncSequence, 50);
  assert.equal((await repository.getNote(note.id))?.title, 'Historical');
});

test('replays events encrypted with a non-current epoch key', async () => {
  const repository = await createRepository(new MemoryDataStore());
  const localState = {
    accountId: 'account-1', deviceId: 'device-1', deviceRole: 'primary_mobile' as const,
    googleUserId: 'google-1', googleEmail: 'writer@example.com', devicePublicKey: '{}',
    recoveryKeyDriveFileId: 'key-1', latestSnapshotDriveFileId: 'snapshot-1',
    currentSyncSequence: 2, linkedAt: 1,
  };
  await repository.saveLocalSyncAccountState(localState);
  const epoch1 = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const epoch2 = Uint8Array.from({ length: 32 }, (_, index) => index + 41);
  const note = { id: 'note-epoch', title: 'Epoch two', body: '', isPinned: false, tags: [], createdAt: 1, updatedAt: 1 };
  const event = createSyncDomainEvent({
    accountId: localState.accountId, deviceId: 'device-2', recordType: 'note', operation: 'upsert',
    recordId: note.id, baseRecordVersion: 0, payload: note,
  });
  const encrypted = await encryptSyncPayload(epoch2, 'event', encodeSyncDomainEvent(event), { keyEpoch: 2 });

  await replaySyncObjects({
    repository,
    localState,
    accountRootKey: epoch1,
    accountRootKeys: { 1: epoch1, 2: epoch2 },
    googleSession: { userId: 'google-1', email: 'writer@example.com', displayName: null, accessToken: 'token' },
    objects: [{
      id: 'object-epoch', accountId: localState.accountId, sequence: 3, driveFileId: 'drive-epoch',
      objectKind: 'event', sha256: encrypted.sha256, sizeBytes: encrypted.bytes.byteLength,
      createdByDeviceId: 'device-2', createdAt: '2026-07-05T00:00:00.000Z',
      recordType: 'note', recordId: note.id, baseRecordVersion: 0, recordVersion: 1, keyEpoch: 2,
    }],
    download: async () => encrypted.bytes,
  });

  assert.equal((await repository.getNote(note.id))?.title, 'Epoch two');
});

test('hydrates replayed stable media references from another device', async () => {
  const repository = await createRepository(new MemoryDataStore());
  const localState = {
    accountId: 'account-1', deviceId: 'device-mobile', deviceRole: 'primary_mobile' as const,
    googleUserId: 'google-1', googleEmail: 'writer@example.com', devicePublicKey: '{}',
    recoveryKeyDriveFileId: 'key-1', latestSnapshotDriveFileId: 'snapshot-1',
    currentSyncSequence: 2, linkedAt: 1,
  };
  await repository.saveLocalSyncAccountState(localState);
  const rootKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const mediaId = 'media-from-web';
  const driveFileId = 'drive-media-web';
  const mediaBytes = new TextEncoder().encode('web photo bytes');
  const encryptedMedia = await encryptSyncPayload(
    rootKey,
    'media',
    encodeSyncMediaPayload(mediaId, 'image/png', mediaBytes),
  );
  const entry = {
    id: 'entry-web-photo',
    diaryId: 'diary-default',
    date: '2026-07-06',
    title: 'Web photo',
    body: '',
    moodName: 'Calm',
    moodEmoji: '',
    tags: [],
    photoUris: [createStableSyncMediaReference(mediaId, driveFileId)],
    photoCount: 1,
    wordCount: 0,
    createdAt: 1,
    updatedAt: 1,
  };
  const event = createSyncDomainEvent({
    accountId: localState.accountId,
    deviceId: 'device-web',
    recordType: 'entry',
    operation: 'upsert',
    recordId: entry.id,
    baseRecordVersion: 0,
    payload: entry,
  });
  const encryptedEvent = await encryptSyncPayload(rootKey, 'event', encodeSyncDomainEvent(event));
  const downloads = new Map([
    [driveFileId, encryptedMedia.bytes],
    ['drive-event-web', encryptedEvent.bytes],
  ]);

  await replaySyncObjects({
    repository,
    localState,
    accountRootKey: rootKey,
    googleSession: { userId: 'google-1', email: 'writer@example.com', displayName: null, accessToken: 'token' },
    objects: [
      {
        id: 'object-media-web',
        accountId: localState.accountId,
        sequence: 3,
        driveFileId,
        objectKind: 'media',
        sha256: encryptedMedia.sha256,
        sizeBytes: encryptedMedia.bytes.byteLength,
        createdByDeviceId: 'device-web',
        createdAt: '2026-07-06T00:00:00.000Z',
      },
      {
        id: 'object-event-web',
        accountId: localState.accountId,
        sequence: 4,
        driveFileId: 'drive-event-web',
        objectKind: 'event',
        sha256: encryptedEvent.sha256,
        sizeBytes: encryptedEvent.bytes.byteLength,
        createdByDeviceId: 'device-web',
        createdAt: '2026-07-06T00:00:01.000Z',
        recordType: 'entry',
        recordId: entry.id,
        baseRecordVersion: 0,
        recordVersion: 1,
      },
    ],
    download: async (_session, fileId) => downloads.get(fileId)!,
  });

  const stored = await repository.getEntry(entry.id);
  assert.equal(stored?.photoUris[0], entry.photoUris[0]);

  const engine = new EventSyncEngine(repository, {
    isOnline: () => true,
    loadSecrets: async () => ({
      version: 1 as const,
      accountId: localState.accountId,
      accountRootKey: rootKey,
      devicePrivateKeyJwk: '{}',
      supabaseSession: { accessToken: 'supabase', refreshToken: 'refresh', expiresAt: 2_000_000_000 },
    }),
    restoreGoogleSession: async () => ({
      userId: 'google-1',
      email: 'writer@example.com',
      displayName: null,
      accessToken: 'drive',
    }),
    createControlPlane: () => ({
      getDeviceStatus: async () => ({
        id: localState.deviceId,
        accountId: localState.accountId,
        role: localState.deviceRole,
        publicKey: '{}',
        displayName: 'Phone',
        platform: 'android',
        createdAt: '',
        lastSeenAt: '',
        revokedAt: null,
        replacedByDeviceId: null,
      }),
    } as any),
    download: async (_session, fileId) => downloads.get(fileId)!,
  });

  const hydrated = await engine.hydrateEntries([stored!]);
  assert.equal(hydrated[0].photoUris[0], 'data:image/png;base64,d2ViIHBob3RvIGJ5dGVz');
  assert.equal((await repository.getSyncMediaPointerByDriveFileId(driveFileId))?.mediaId, mediaId);
});
