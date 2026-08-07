import type { DiaryRepository } from '../../../repositories/DiaryRepository';
import { cacheSyncMedia, decodeSyncMediaPayload, parseSyncMediaReference } from '../../syncMedia';
import { decryptSyncPayload } from '../../encryptedSyncObject';
import type { SyncV2ApiClient } from '../api/SyncV2ApiClient';
import { BoundedObjectTransfer } from '../operation/BoundedObjectTransfer';
import { syncV2ObjectKeyForId } from './SyncV2MediaPreparer';

export class SyncV2MediaHydrator {
  private readonly inFlight = new Map<string, Promise<string>>();

  constructor(
    private readonly api: Pick<SyncV2ApiClient, 'getMediaDownload'>,
    private readonly repository: DiaryRepository,
    private readonly keyForEpoch: (epoch: number) => Promise<Uint8Array>,
    maximumMediaBytes: number,
    private readonly accountId: string,
  ) {
    this.transfer = new BoundedObjectTransfer({ maximumObjectBytes: maximumMediaBytes });
  }

  private readonly transfer: BoundedObjectTransfer;

  hydrate(reference: string): Promise<string> {
    const existing = this.inFlight.get(reference);
    if (existing) return existing;
    const task = this.hydrateOnce(reference).finally(() => this.inFlight.delete(reference));
    this.inFlight.set(reference, task);
    return task;
  }

  private async hydrateOnce(reference: string): Promise<string> {
    const parsed = parseSyncMediaReference(reference);
    if (!parsed?.driveFileId) return reference;
    const stored = await this.repository.getSyncMediaPointerByMediaId(parsed.mediaId);
    if (stored?.localUri) return stored.localUri;
    const instruction = await this.api.getMediaDownload(parsed.driveFileId);
    const [encrypted] = await this.transfer.download([instruction]);
    const decrypted = await decryptSyncPayload(
      await this.keyForEpoch(instruction.keyEpoch),
      encrypted,
    );
    if (decrypted.objectKind !== 'media') {
      throw new Error('Downloaded encrypted object is not media.');
    }
    const media = decodeSyncMediaPayload(decrypted.payload);
    if (media.mediaId !== parsed.mediaId) {
      throw new Error('Downloaded media identity does not match its reference.');
    }
    const localUri = await cacheSyncMedia(media.mediaId, media.mimeType, media.bytes);
    const objectKey =
      stored?.driveFileId || (await syncV2ObjectKeyForId(this.accountId, instruction.objectId));
    await this.repository.saveSyncMediaPointer({
      mediaId: media.mediaId,
      sequence: stored?.sequence || 0,
      driveFileId: objectKey,
      sha256: instruction.sha256,
      sizeBytes: instruction.sizeBytes,
      createdByDeviceId: stored?.createdByDeviceId || 'remote',
      createdAt: stored?.createdAt || new Date().toISOString(),
      localUri,
      thumbnailSequence: stored?.thumbnailSequence,
      thumbnailDriveFileId: stored?.thumbnailDriveFileId,
      thumbnailSha256: stored?.thumbnailSha256,
      thumbnailSizeBytes: stored?.thumbnailSizeBytes,
      keyEpoch: instruction.keyEpoch,
    });
    return localUri;
  }
}
