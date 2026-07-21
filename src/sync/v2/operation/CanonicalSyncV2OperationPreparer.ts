import { sanitizeEntry, sanitizeNote } from '../../../domain/richTextSanitizer';
import { SyncError } from '../../errors';
import type { SyncOutboxOperationV2 } from '../../outbox';
import type { PreparedSyncV2Operation, SyncV2OperationPreparer } from './SyncV2OperationProcessor';
import { NOOP_SYNC_FAULT_INJECTOR, type SyncFaultInjector } from '../faults/SyncFaultInjector';
import { NOOP_TELEMETRY, type Telemetry } from '../../../infrastructure/telemetry/Telemetry';

export interface CanonicalEventPreparationDependencies {
  eventSchemaVersion: number;
  loadAuthoritativeRecord(operation: SyncOutboxOperationV2): Promise<unknown | null>;
  determinePartitionKey(operation: SyncOutboxOperationV2, payload: unknown | null): Promise<string>;
  currentKeyEpoch(): Promise<number>;
  validateEvent(event: Record<string, unknown>): Promise<void> | void;
  encryptEvent(event: Record<string, unknown>, keyEpoch: number): Promise<Uint8Array>;
  createObjectKey?(accountId: string): Promise<string>;
}

const defaultObjectKey = async (accountId: string): Promise<string> => {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(accountId)),
  );
  const namespace = Array.from(digest.slice(0, 16), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return `accounts/${namespace}/objects/${crypto.randomUUID()}`;
};

const sanitizedPayload = (
  operation: SyncOutboxOperationV2,
  payload: unknown | null,
): unknown | null => {
  if (!payload) return payload;
  if (operation.recordType === 'ENTRY')
    return sanitizeEntry(payload as Parameters<typeof sanitizeEntry>[0]);
  if (operation.recordType === 'NOTE')
    return sanitizeNote(payload as Parameters<typeof sanitizeNote>[0]);
  return payload;
};

export class CanonicalSyncV2OperationPreparer implements SyncV2OperationPreparer {
  constructor(
    private readonly dependencies: CanonicalEventPreparationDependencies,
    private readonly faults: SyncFaultInjector = NOOP_SYNC_FAULT_INJECTOR,
    private readonly telemetry: Telemetry = NOOP_TELEMETRY,
  ) {}

  async prepare(operation: SyncOutboxOperationV2): Promise<PreparedSyncV2Operation> {
    const loadSpan = this.telemetry.startSpan('record.load', { record_type: operation.recordType });
    const authoritative =
      operation.operationType === 'DELETE'
        ? null
        : await this.dependencies.loadAuthoritativeRecord(operation);
    loadSpan.end();
    if (operation.operationType === 'UPSERT' && authoritative === null) {
      throw new SyncError({ code: 'LOCAL_DATABASE_FAILURE', safetyRelevant: true });
    }
    const payload = sanitizedPayload(operation, authoritative);
    const [partitionKey, keyEpoch, objectKey] = await Promise.all([
      this.dependencies.determinePartitionKey(operation, payload),
      this.dependencies.currentKeyEpoch(),
      (this.dependencies.createObjectKey || defaultObjectKey)(operation.accountId),
    ]);
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
      payload,
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
      objects: [{ objectKey, objectKind: 'EVENT', bytes: encrypted }],
    };
  }
}
