import type { DiaryRepository } from '../repositories';
import type {
  GoogleAccountSession,
  LocalSyncAccountState,
  SyncMediaPointer,
  SyncObjectMetadata,
} from '../types';
import { decodeSyncDomainEvent } from './domainEvents';
import { downloadDriveSyncObject } from './driveSyncObjects';
import { decryptSyncPayloadWithKnownKeys } from './encryptedSyncObject';

export type SyncObjectDownloader = (
  session: GoogleAccountSession,
  fileId: string,
) => Promise<Uint8Array>;

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

export const downloadVerifiedSyncObject = async (
  session: GoogleAccountSession,
  object: SyncObjectMetadata,
  download: SyncObjectDownloader = downloadDriveSyncObject,
): Promise<Uint8Array> => {
  const bytes = await download(session, object.driveFileId);
  if ((await sha256Hex(bytes)) !== object.sha256) {
    throw new Error(`Synced ${object.objectKind.replace('_', ' ')} failed integrity verification.`);
  }
  return bytes;
};

export interface ReplaySyncObjectsInput {
  repository: DiaryRepository;
  localState: LocalSyncAccountState;
  accountRootKey: Uint8Array;
  accountRootKeys?: Record<number, Uint8Array>;
  googleSession: GoogleAccountSession;
  objects: SyncObjectMetadata[];
  download?: SyncObjectDownloader;
  allowHistorical?: boolean;
}

export const replaySyncObjects = async ({
  repository,
  localState,
  accountRootKey,
  accountRootKeys,
  googleSession,
  objects,
  download,
  allowHistorical = false,
}: ReplaySyncObjectsInput): Promise<LocalSyncAccountState> => {
  let state = localState;
  let lastMediaPointer: SyncMediaPointer | null = null;
  const ordered = [...objects].sort((left, right) => left.sequence - right.sequence);
  for (const object of ordered) {
    if (!allowHistorical && object.sequence <= state.currentSyncSequence) continue;
    if (object.accountId !== state.accountId)
      throw new Error('Sync metadata belongs to another account.');

    if (object.objectKind === 'event') {
      const encrypted = await downloadVerifiedSyncObject(googleSession, object, download);
      const decrypted = await decryptSyncPayloadWithKnownKeys(
        encrypted,
        accountRootKey,
        accountRootKeys,
        object.keyEpoch,
      );
      if (decrypted.objectKind !== 'event')
        throw new Error('Sync object metadata does not match its encrypted payload.');
      const event = decodeSyncDomainEvent(decrypted.payload);
      if (
        event.accountId !== state.accountId ||
        event.recordType !== object.recordType ||
        event.recordId !== object.recordId ||
        event.baseRecordVersion !== object.baseRecordVersion ||
        event.recordVersion !== object.recordVersion
      ) {
        throw new Error('Encrypted sync event does not match its control-plane metadata.');
      }
      if (
        JSON.stringify(event.affectedRecords || []) !== JSON.stringify(object.affectedRecords || [])
      ) {
        throw new Error(
          'Encrypted sync event affected records do not match control-plane metadata.',
        );
      }
      await repository.applySyncEvent(event, object.sequence, { allowHistorical });
      lastMediaPointer = null;
    } else {
      if (object.objectKind === 'media') {
        lastMediaPointer = {
          mediaId: '',
          sequence: object.sequence,
          driveFileId: object.driveFileId,
          sha256: object.sha256,
          sizeBytes: object.sizeBytes,
          createdByDeviceId: object.createdByDeviceId,
          createdAt: object.createdAt,
          keyEpoch: object.keyEpoch || 1,
        };
        await repository.saveSyncMediaPointer(lastMediaPointer);
      } else if (object.objectKind === 'thumbnail' && lastMediaPointer) {
        lastMediaPointer = {
          ...lastMediaPointer,
          thumbnailSequence: object.sequence,
          thumbnailDriveFileId: object.driveFileId,
          thumbnailSha256: object.sha256,
          thumbnailSizeBytes: object.sizeBytes,
        };
        await repository.saveSyncMediaPointer(lastMediaPointer);
      } else {
        lastMediaPointer = null;
      }
      await repository.saveLocalSyncAccountState({
        ...state,
        currentSyncSequence: Math.max(state.currentSyncSequence, object.sequence),
      });
    }
    state = { ...state, currentSyncSequence: Math.max(state.currentSyncSequence, object.sequence) };
  }
  return state;
};
