import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryDataStore, createRepository } from './testSupport';
import { createSyncDomainEvent, encodeSyncDomainEvent } from './domainEvents';
import { encryptSyncPayload } from './encryptedSyncObject';
import { replaySyncObjects } from './eventReplay';

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
