import { sanitizeEntry, sanitizeNote } from '../../../domain/richTextSanitizer';
import { SyncError } from '../../errors';
import type { SyncOperation } from '../../outbox';
import type { PreparedSyncOperation, SyncOperationPreparer } from './SyncOperationProcessor';
import { NOOP_SYNC_FAULT_INJECTOR, type SyncFaultInjector } from '../faults/SyncFaultInjector';
import { NOOP_TELEMETRY, type Telemetry } from '../../../infrastructure/telemetry/Telemetry';
import type { SyncMediaPreparer } from '../media/SyncMediaPreparer';
import { base64ToPreparedBytes } from '../media/SyncMediaPreparer';
import { toPortableSyncPayload } from '../../portableMedia';

export interface CanonicalEventPreparationDependencies {
  eventSchemaVersion: number;
  loadAuthoritativeRecord(operation: SyncOperation): Promise<unknown | null>;
  determinePartitionKey(operation: SyncOperation, payload: unknown | null): Promise<string>;
  currentKeyEpoch(): Promise<number>;
  validateEvent(event: Record<string, unknown>): Promise<void> | void;
  encryptEvent(event: Record<string, unknown>, keyEpoch: number): Promise<Uint8Array>;
  createObjectKey?(accountId: string): Promise<string>;
  mediaPreparer?: SyncMediaPreparer;
}

export const createSyncObjectKey = async (accountId: string): Promise<string> => {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(accountId)),
  );
  const namespace = Array.from(digest.slice(0, 16), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return `accounts/${namespace}/objects/${crypto.randomUUID()}`;
};

const sanitizedPayload = (
  operation: SyncOperation,
  payload: unknown | null,
): unknown | null => {
  if (!payload) return payload;
  if (operation.recordType === 'ENTRY')
    return sanitizeEntry(payload as Parameters<typeof sanitizeEntry>[0]);
  if (operation.recordType === 'NOTE')
    return sanitizeNote(payload as Parameters<typeof sanitizeNote>[0]);
  return payload;
};

export class CanonicalSyncOperationPreparer implements SyncOperationPreparer {
  constructor(
    private readonly dependencies: CanonicalEventPreparationDependencies,
    private readonly faults: SyncFaultInjector = NOOP_SYNC_FAULT_INJECTOR,
    private readonly telemetry: Telemetry = NOOP_TELEMETRY,
  ) {}

  async prepare(operation: SyncOperation): Promise<PreparedSyncOperation> {
    if (operation.preparedObjects?.length) {
      return {
        partitionKey: operation.partitionKey || 'account',
        keyEpoch: operation.keyEpoch || (await this.dependencies.currentKeyEpoch()),
        eventSchemaVersion:
          operation.encryptedEventSchemaVersion || this.dependencies.eventSchemaVersion,
        canonicalPayload: operation.preparedCanonicalPayload ?? null,
        mediaPointers: operation.preparedMediaPointers || [],
        retainedMediaObjects: operation.retainedMediaObjects || [],
        objects: operation.preparedObjects.map((object) => ({
          objectKey: object.objectKey,
          objectKind: object.objectKind,
          bytes: base64ToPreparedBytes(object.encryptedBase64),
        })),
      };
    }
    const loadSpan = this.telemetry.startSpan('record.load', { record_type: operation.recordType });
    const authoritative =
      operation.operationType === 'DELETE'
        ? null
        : operation.sourceCanonicalPayload !== undefined
          ? structuredClone(operation.sourceCanonicalPayload)
          : await this.dependencies.loadAuthoritativeRecord(operation);
    loadSpan.end();
    if (operation.operationType === 'UPSERT' && authoritative === null) {
      throw new SyncError({ code: 'LOCAL_DATABASE_FAILURE', safetyRelevant: true });
    }
    const payload = sanitizedPayload(operation, authoritative);
    const [partitionKey, keyEpoch, objectKey] = await Promise.all([
      this.dependencies.determinePartitionKey(operation, payload),
      this.dependencies.currentKeyEpoch(),
      (this.dependencies.createObjectKey || createSyncObjectKey)(operation.accountId),
    ]);
    const media = this.dependencies.mediaPreparer
      ? await this.dependencies.mediaPreparer.prepare(
          operation.accountId,
          recordTypeToRepository(operation.recordType),
          sanitizedPayload(operation, authoritative),
          keyEpoch,
        )
      : {
          payload: toPortableSyncPayload(
            recordTypeToRepository(operation.recordType),
            sanitizedPayload(operation, authoritative),
          ),
          objects: [],
          pointers: [],
          retainedMediaObjects: [],
        };
    const event: Record<string, unknown> = {
      schemaVersion: this.dependencies.eventSchemaVersion,
      accountId: operation.accountId,
      operationId: operation.operationId,
      deviceId: operation.deviceId,
      recordType: operation.recordType,
      recordId: operation.recordId,
      operationType: operation.operationType,
      baseRecordVersion: operation.baseRecordVersion,
      recordVersion: operation.baseRecordVersion + 1,
      keyEpoch,
      partitionKey,
      payload: media.payload,
      mediaPointers: media.pointers.map((pointer) => ({
        mediaId: pointer.mediaId,
        objectKey: pointer.objectKey,
        thumbnailObjectKey: pointer.thumbnailObjectKey,
      })),
    };
    await this.dependencies.validateEvent(event);
    const encryptionSpan = this.telemetry.startSpan('event.encrypt', {
      record_type: operation.recordType,
    });
    await this.faults.hit('BEFORE_EVENT_ENCRYPTION');
    const encrypted = await this.dependencies.encryptEvent(event, keyEpoch);
    await this.faults.hit('AFTER_EVENT_ENCRYPTION');
    encryptionSpan.end();
    return {
      partitionKey,
      keyEpoch,
      eventSchemaVersion: this.dependencies.eventSchemaVersion,
      canonicalPayload: media.payload,
      mediaPointers: media.pointers,
      retainedMediaObjects: media.retainedMediaObjects,
      objects: [
        { objectKey, objectKind: 'EVENT', bytes: encrypted },
        ...media.objects.map((object) => ({
          objectKey: object.objectKey,
          objectKind: object.objectKind,
          bytes: base64ToPreparedBytes(object.encryptedBase64),
        })),
      ],
    };
  }
}

const recordTypeToRepository = (
  recordType: SyncOperation['recordType'],
): 'diary' | 'entry' | 'note' | 'settings' | 'profile' => recordType.toLowerCase() as any;
