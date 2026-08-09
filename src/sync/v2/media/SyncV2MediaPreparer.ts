import type { DiaryRepository } from '../../../repositories/DiaryRepository';
import type { Diary, Entry, SyncRecordType, UserProfile } from '../../../types';
import { encryptSyncPayload } from '../../encryptedSyncObject';
import {
  createImageThumbnail,
  createStableSyncMediaReference,
  encodeSyncMediaPayload,
  encodeSyncThumbnailPayload,
  parseSyncMediaReference,
  readMediaUri,
} from '../../syncMedia';
import type {
  PreparedMediaPointerV2,
  PreparedSyncObjectV2,
} from '../../outbox/SyncOutboxOperationV2';
import type { SyncV2RetainedMediaObject } from '../api/SyncV2ApiTypes';
import { sha256Hex } from '../operation/BoundedObjectTransfer';

export interface PreparedRecordMediaV2 {
  payload: unknown | null;
  objects: PreparedSyncObjectV2[];
  pointers: PreparedMediaPointerV2[];
  retainedMediaObjects: SyncV2RetainedMediaObject[];
}

export interface SyncV2MediaPreparerDependencies {
  repository: DiaryRepository;
  keyForEpoch(epoch: number): Promise<Uint8Array>;
  createObjectKey(accountId: string): Promise<string>;
}

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return typeof btoa === 'function'
    ? btoa(binary)
    : Buffer.from(binary, 'binary').toString('base64');
};

export const base64ToPreparedBytes = (value: string): Uint8Array => {
  const binary =
    typeof atob === 'function' ? atob(value) : Buffer.from(value, 'base64').toString('binary');
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const objectIdFromKey = (objectKey: string): string => objectKey.slice(objectKey.lastIndexOf('/') + 1);

export const syncV2ObjectKeyForId = (accountId: string, objectId: string): Promise<string> =>
  crypto.subtle
    .digest('SHA-256', new TextEncoder().encode(accountId))
    .then((digest) => {
      const namespace = Array.from(new Uint8Array(digest).slice(0, 16), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
      return `accounts/${namespace}/objects/${objectId}`;
    });

export class SyncV2MediaPreparer {
  constructor(private readonly dependencies: SyncV2MediaPreparerDependencies) {}

  async prepare(
    accountId: string,
    recordType: SyncRecordType,
    source: unknown | null,
    keyEpoch: number,
  ): Promise<PreparedRecordMediaV2> {
    if (!source || !['diary', 'entry', 'profile'].includes(recordType)) {
      return { payload: source, objects: [], pointers: [], retainedMediaObjects: [] };
    }
    const payload = structuredClone(source) as Diary | Entry | UserProfile;
    const objects: PreparedSyncObjectV2[] = [];
    const pointers: PreparedMediaPointerV2[] = [];
    const retained = new Map<string, SyncV2RetainedMediaObject>();
    const key = await this.dependencies.keyForEpoch(keyEpoch);

    const prepareUri = async (uri: string | undefined): Promise<string | undefined> => {
      if (!uri) return undefined;
      const parsed = parseSyncMediaReference(uri);
      if (parsed) {
        const stored = await this.dependencies.repository.getSyncMediaPointerByMediaId(parsed.mediaId);
        const objectKey =
          stored?.driveFileId ||
          (parsed.driveFileId
            ? await syncV2ObjectKeyForId(accountId, parsed.driveFileId)
            : undefined);
        if (!objectKey) return uri;
        retained.set(objectKey, { objectKey, objectKind: 'MEDIA' });
        if (stored?.thumbnailDriveFileId) {
          retained.set(stored.thumbnailDriveFileId, {
            objectKey: stored.thumbnailDriveFileId,
            objectKind: 'THUMBNAIL',
          });
        }
        pointers.push({
          mediaId: parsed.mediaId,
          objectKey,
          localUri: stored?.localUri,
          thumbnailObjectKey: stored?.thumbnailDriveFileId,
        });
        return createStableSyncMediaReference(parsed.mediaId, objectIdFromKey(objectKey));
      }

      const existing = await this.dependencies.repository.getSyncMediaPointerByLocalUri(uri);
      if (existing?.driveFileId) {
        retained.set(existing.driveFileId, {
          objectKey: existing.driveFileId,
          objectKind: 'MEDIA',
        });
        if (existing.thumbnailDriveFileId) {
          retained.set(existing.thumbnailDriveFileId, {
            objectKey: existing.thumbnailDriveFileId,
            objectKind: 'THUMBNAIL',
          });
        }
        pointers.push({
          mediaId: existing.mediaId,
          objectKey: existing.driveFileId,
          localUri: uri,
          thumbnailObjectKey: existing.thumbnailDriveFileId,
        });
        return createStableSyncMediaReference(
          existing.mediaId,
          objectIdFromKey(existing.driveFileId),
        );
      }

      const media = await readMediaUri(uri);
      const mediaId = crypto.randomUUID();
      const objectKey = await this.dependencies.createObjectKey(accountId);
      const encrypted = await encryptSyncPayload(
        key,
        'media',
        encodeSyncMediaPayload(mediaId, media.mimeType, media.bytes),
        { keyEpoch },
      );
      objects.push({
        objectKey,
        objectKind: 'MEDIA',
        sha256: encrypted.sha256,
        sizeBytes: encrypted.bytes.byteLength,
        encryptedBase64: bytesToBase64(encrypted.bytes),
      });

      let thumbnailObjectKey: string | undefined;
      const thumbnail = await createImageThumbnail(media);
      if (thumbnail) {
        thumbnailObjectKey = await this.dependencies.createObjectKey(accountId);
        const encryptedThumbnail = await encryptSyncPayload(
          key,
          'thumbnail',
          encodeSyncThumbnailPayload(mediaId, thumbnail.mimeType, thumbnail.bytes),
          { keyEpoch },
        );
        objects.push({
          objectKey: thumbnailObjectKey,
          objectKind: 'THUMBNAIL',
          sha256: encryptedThumbnail.sha256,
          sizeBytes: encryptedThumbnail.bytes.byteLength,
          encryptedBase64: bytesToBase64(encryptedThumbnail.bytes),
        });
      }
      pointers.push({ mediaId, objectKey, localUri: uri, thumbnailObjectKey });
      return createStableSyncMediaReference(mediaId, objectIdFromKey(objectKey));
    };

    if (recordType === 'diary') {
      (payload as Diary).coverImage = await prepareUri((payload as Diary).coverImage);
    } else if (recordType === 'profile') {
      (payload as UserProfile).avatarUri = await prepareUri((payload as UserProfile).avatarUri);
    } else {
      const entry = payload as Entry;
      entry.photoUris = (
        await Promise.all((entry.photoUris || []).map((uri) => prepareUri(uri)))
      ).filter((uri): uri is string => Boolean(uri));
      entry.photoCount = entry.photoUris.length;
      entry.audioUri = await prepareUri(entry.audioUri);
      if (entry.blocks) {
        entry.blocks = await Promise.all(
          entry.blocks.map(async (block) => ({
            ...block,
            audioUri: await prepareUri(block.audioUri),
          })),
        );
      }
    }

    // Ensure generated metadata agrees with the staged ciphertext before it enters the outbox.
    for (const object of objects) {
      if ((await sha256Hex(base64ToPreparedBytes(object.encryptedBase64))) !== object.sha256) {
        throw new Error('Prepared encrypted media failed its local integrity check.');
      }
    }
    return {
      payload,
      objects,
      pointers,
      retainedMediaObjects: [...retained.values()],
    };
  }
}
