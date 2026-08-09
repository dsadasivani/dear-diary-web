import type { DiaryRepository } from '../../../repositories/DiaryRepository';
import type { SyncDomainEvent, SyncRecordType } from '../../../types';
import { toPortableSyncPayload } from '../../portableMedia';
import type {
  DecryptedSyncV2Event,
  ReplayBatchEvent,
  SyncV2ReplayStore,
} from './PersistentReplayStore';
import { PersistentReplayStore } from './PersistentReplayStore';

const recordTypeToLegacy: Record<DecryptedSyncV2Event['recordType'], SyncRecordType> = {
  DIARY: 'diary',
  ENTRY: 'entry',
  NOTE: 'note',
  SETTINGS: 'settings',
  PROFILE: 'profile',
};

export const toDomainEvent = (
  deviceId: string,
  eventId: string,
  event: DecryptedSyncV2Event,
): SyncDomainEvent =>
  ({
    version: 1,
    eventId,
    accountId: event.accountId,
    deviceId,
    createdAt: new Date().toISOString(),
    operation:
      event.operationType === 'DELETE' ? 'delete' : event.recordVersion === 1 ? 'create' : 'update',
    recordType: recordTypeToLegacy[event.recordType],
    recordId: event.recordId,
    baseRecordVersion: event.recordVersion - 1,
    recordVersion: event.recordVersion,
    payload: event.payload,
  }) as SyncDomainEvent;

export class RepositoryReplayStore implements SyncV2ReplayStore {
  constructor(
    private readonly persistent: PersistentReplayStore,
    private readonly repository: DiaryRepository,
    private readonly atomicReplayEnabled = true,
  ) {}

  getLastAppliedSequence() {
    return this.persistent.getLastAppliedSequence();
  }

  hasAppliedEvent(eventId: string) {
    return this.persistent.hasAppliedEvent(eventId);
  }

  async applyBatch(events: ReplayBatchEvent[]): Promise<number> {
    const portableEvents = events.map(({ envelope, event }) => ({
      envelope,
      event: {
        ...event,
        payload: toPortableSyncPayload(recordTypeToLegacy[event.recordType], event.payload),
      },
    }));
    if (!this.atomicReplayEnabled) {
      for (const { envelope, event } of portableEvents) {
        await this.repository.applySyncEvent(
          toDomainEvent(envelope.deviceId, envelope.eventId, event),
          envelope.sequence,
        );
        for (const pointer of event.mediaPointers || []) {
          await this.repository.saveSyncMediaPointer({
            mediaId: pointer.mediaId,
            sequence: envelope.sequence,
            driveFileId: pointer.objectKey,
            sha256: '',
            sizeBytes: 0,
            createdByDeviceId: envelope.deviceId,
            createdAt: new Date().toISOString(),
            thumbnailSequence: pointer.thumbnailObjectKey ? envelope.sequence : undefined,
            thumbnailDriveFileId: pointer.thumbnailObjectKey,
            keyEpoch: envelope.keyEpoch,
          });
        }
      }
      return this.persistent.applyBatch(portableEvents);
    }
    const expectedCursor = await this.persistent.getLastAppliedSequence();
    return this.repository.applyRemoteEventBatch(
      portableEvents.map(({ envelope, event }) => ({
        event: toDomainEvent(envelope.deviceId, envelope.eventId, event),
        sequence: envelope.sequence,
        operationId: envelope.operationId,
        mediaPointers: (event.mediaPointers || []).map((pointer) => ({
          mediaId: pointer.mediaId,
          sequence: envelope.sequence,
          driveFileId: pointer.objectKey,
          sha256: '',
          sizeBytes: 0,
          createdByDeviceId: envelope.deviceId,
          createdAt: new Date().toISOString(),
          thumbnailSequence: pointer.thumbnailObjectKey ? envelope.sequence : undefined,
          thumbnailDriveFileId: pointer.thumbnailObjectKey,
          keyEpoch: envelope.keyEpoch,
        })),
      })),
      expectedCursor,
    );
  }
}
