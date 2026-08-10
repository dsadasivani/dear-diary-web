import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSyncMediaReference,
  decodeSyncMediaPayload,
  decodeSyncThumbnailPayload,
  encodeSyncMediaPayload,
  encodeSyncThumbnailPayload,
  parseSyncMediaReference,
  readMediaUri,
} from './syncMedia';
import {
  isDeviceLocalMediaUri,
  toPortableDiary,
  toPortableEntry,
  toPortableUserProfile,
} from './portableMedia';
import { EventSyncEngine } from './eventSyncEngine';
import type { DiaryRepository } from '../repositories/DiaryRepository';

test('round-trips binary media payloads without base64 expansion', () => {
  const bytes = Uint8Array.from([0, 1, 2, 128, 255]);
  const decoded = decodeSyncMediaPayload(encodeSyncMediaPayload('media-1', 'image/jpeg', bytes));
  assert.equal(decoded.mediaId, 'media-1');
  assert.equal(decoded.mimeType, 'image/jpeg');
  assert.deepEqual(decoded.bytes, bytes);
});

test('round-trips portable media references', () => {
  const reference = createSyncMediaReference('media-2', 'drive_file-2');
  assert.deepEqual(parseSyncMediaReference(reference), {
    mediaId: 'media-2',
    driveFileId: 'drive_file-2',
  });
  assert.equal(parseSyncMediaReference('https://local/photo.jpg'), null);
});

test('round-trips encrypted thumbnail payload input', () => {
  const bytes = Uint8Array.from([7, 8, 9]);
  const decoded = decodeSyncThumbnailPayload(
    encodeSyncThumbnailPayload('media-thumb', 'image/jpeg', bytes),
  );
  assert.equal(decoded.mediaId, 'media-thumb');
  assert.equal(decoded.mimeType, 'image/jpeg');
  assert.equal(decoded.source, 'thumbnail');
  assert.deepEqual(decoded.bytes, bytes);
});

test('reads audio data URIs with media type parameters', async () => {
  const media = await readMediaUri('data:audio/webm;codecs=opus;base64,aGVsbG8=');

  assert.equal(media.mimeType, 'audio/webm;codecs=opus');
  assert.equal(new TextDecoder().decode(media.bytes), 'hello');
});

test('removes device-local media while retaining portable references', () => {
  const nativeAvatar =
    'http://localhost/_capacitor_file_/data/user/0/com.deardiary.app/files/media/avatar.png';
  assert.equal(isDeviceLocalMediaUri(nativeAvatar), true);
  assert.equal(isDeviceLocalMediaUri('ddmedia:media-1:object-1'), false);

  assert.equal(
    toPortableUserProfile({
      name: 'Writer',
      email: 'writer@example.com',
      bio: '',
      avatarEmoji: '🌸',
      avatarColor: '#8A3D55',
      avatarUri: nativeAvatar,
      writingGoal: 500,
      joinedDate: '08/2026',
    }).avatarUri,
    undefined,
  );
  assert.equal(
    toPortableDiary({
      id: 'diary-1',
      name: 'Diary',
      emoji: '📖',
      color: '#fff',
      isLocked: false,
      entryCount: 1,
      lastUpdated: 'Today',
      coverImage: 'file:///private/cover.jpg',
    }).coverImage,
    undefined,
  );

  const entry = toPortableEntry({
    id: 'entry-1',
    diaryId: 'diary-1',
    date: '2026-08-07',
    title: 'Portable',
    body: '',
    moodName: 'Calm',
    moodEmoji: '',
    tags: [],
    photoUris: [nativeAvatar, 'ddmedia:media-1:object-1'],
    photoCount: 2,
    wordCount: 0,
    audioUri: 'content://recording/1',
    createdAt: 1,
    updatedAt: 1,
    blocks: [{ id: 'block-1', time: '10:00', body: '', audioUri: 'blob:local-audio' }],
  });
  assert.deepEqual(entry.photoUris, ['ddmedia:media-1:object-1']);
  assert.equal(entry.photoCount, 1);
  assert.equal(entry.audioUri, undefined);
  assert.equal(entry.blocks?.[0].audioUri, undefined);
});

test('web hydration suppresses a device-local URL cached by an older client', async () => {
  const engine = new EventSyncEngine({} as DiaryRepository);
  const nativeAvatar =
    'http://localhost/_capacitor_file_/data/user/0/com.deardiary.app/files/media/avatar.png';

  assert.equal(await engine.hydrateMediaReference(nativeAvatar), '');
});
