import assert from 'node:assert/strict';
import test from 'node:test';
import type { DiaryRepository } from '../../repositories/DiaryRepository';
import type { Entry, SyncMediaPointer } from '../../types';
import { decryptSyncPayload, encryptSyncPayload } from '../encryptedSyncObject';
import { decodeSyncMediaPayload, encodeSyncMediaPayload, parseSyncMediaReference } from '../syncMedia';
import { sha256Hex } from './operation/BoundedObjectTransfer';
import { SyncV2MediaPreparer } from './media/SyncV2MediaPreparer';
import { SyncV2MediaHydrator } from './media/SyncV2MediaHydrator';

const key = new Uint8Array(32).fill(7);

const entry = (): Entry => ({
  id: 'entry-1',
  diaryId: 'diary-1',
  date: '2026-08-01',
  title: 'Media',
  body: '<p>Hello</p>',
  moodName: 'Calm',
  moodEmoji: 'C',
  tags: [],
  photoUris: ['data:image/png;base64,AQID'],
  photoCount: 1,
  wordCount: 1,
  audioUri: 'data:audio/webm;base64,BAUG',
  blocks: [{ id: 'block-1', time: '10:00', body: '', audioUri: 'data:audio/webm;base64,BwgJ' }],
  createdAt: 1,
  updatedAt: 1,
});

test('prepares every entry media field and reuses registered local objects', async () => {
  const pointers = new Map<string, SyncMediaPointer>();
  let objectIndex = 0;
  const repository = {
    getSyncMediaPointerByMediaId: async (mediaId: string) =>
      [...pointers.values()].find((pointer) => pointer.mediaId === mediaId) || null,
    getSyncMediaPointerByLocalUri: async (uri: string) => pointers.get(uri) || null,
  } as unknown as DiaryRepository;
  const preparer = new SyncV2MediaPreparer({
    repository,
    keyForEpoch: async () => key,
    createObjectKey: async () =>
      `accounts/namespace/objects/00000000-0000-4000-8000-${String(++objectIndex).padStart(12, '0')}`,
  });

  const first = await preparer.prepare('account-1', 'entry', entry(), 1);
  const portable = first.payload as Entry;
  assert.equal(first.objects.filter((object) => object.objectKind === 'MEDIA').length, 3);
  assert.equal(first.pointers.length, 3);
  assert.ok(portable.photoUris.every((uri) => parseSyncMediaReference(uri)));
  assert.ok(parseSyncMediaReference(portable.audioUri));
  assert.ok(parseSyncMediaReference(portable.blocks?.[0].audioUri));

  first.pointers.forEach((pointer) => {
    pointers.set(pointer.localUri!, {
      mediaId: pointer.mediaId,
      sequence: 1,
      driveFileId: pointer.objectKey,
      sha256: '',
      sizeBytes: 0,
      createdByDeviceId: 'device',
      createdAt: new Date(0).toISOString(),
      localUri: pointer.localUri,
    });
  });
  const second = await preparer.prepare('account-1', 'entry', entry(), 1);
  assert.equal(second.objects.length, 0);
  assert.equal(second.retainedMediaObjects.length, 3);
});

test('downloads, verifies, decrypts, and caches a stable media reference', async () => {
  const mediaId = 'media-1';
  const objectId = '00000000-0000-4000-8000-000000000001';
  const encrypted = await encryptSyncPayload(
    key,
    'media',
    encodeSyncMediaPayload(mediaId, 'image/png', new Uint8Array([1, 2, 3])),
    { keyEpoch: 1 },
  );
  const saved: SyncMediaPointer[] = [];
  const repository = {
    getSyncMediaPointerByMediaId: async () => null,
    saveSyncMediaPointer: async (pointer: SyncMediaPointer) => {
      saved.push(pointer);
    },
  } as unknown as DiaryRepository;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(encrypted.bytes, { status: 200 });
  try {
    const hydrator = new SyncV2MediaHydrator(
      {
        getMediaDownload: async () => ({
          objectId,
          objectKind: 'MEDIA',
          sha256: await sha256Hex(encrypted.bytes),
          sizeBytes: encrypted.bytes.byteLength,
          keyEpoch: 1,
          downloadUrl: 'https://download.invalid/media',
          downloadExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      },
      repository,
      async () => key,
      1024 * 1024,
      'account-1',
    );
    const resolved = await hydrator.hydrate(`ddmedia:v2:${mediaId}:${objectId}`);
    assert.equal(resolved, 'data:image/png;base64,AQID');
    assert.equal(saved.length, 1);
    const decoded = decodeSyncMediaPayload(
      (await decryptSyncPayload(key, encrypted.bytes)).payload,
    );
    assert.equal(decoded.mediaId, mediaId);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
