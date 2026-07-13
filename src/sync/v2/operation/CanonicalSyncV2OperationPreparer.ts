import { sanitizeEntry, sanitizeNote } from '../../../domain/richTextSanitizer';
import { SyncError } from '../../errors';
import type { SyncOutboxOperationV2 } from '../../outbox';
import type { PreparedSyncV2Operation, SyncV2OperationPreparer } from './SyncV2OperationProcessor';

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
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(accountId)));
  const namespace = Array.from(digest.slice(0, 16), byte => byte.toString(16).padStart(2, '0')).join('');
  return `accounts/${namespace}/objects/${crypto.randomUUID()}`;
};

const sanitizedPayload = (operation: SyncOutboxOperationV2, payload: unknown | null): unknown | null => {
  if (!payload) return payload;
  if (operation.recordType === 'ENTRY') return sanitizeEntry(payload as Parameters<typeof sanitizeEntry>[0]);
  if (operation.recordType === 'NOTE') return sanitizeNote(payload as Parameters<typeof sanitizeNote>[0]);
  return payload;
};

export class CanonicalSyncV2OperationPreparer implements SyncV2OperationPreparer {
  constructor(private readonly dependencies: CanonicalEventPreparationDependencies) {}

  async prepare(operation: SyncOutboxOperationV2): Promise<PreparedSyncV2Operation> {
    const authoritative = operation.operationType === 'DELETE'
      ? null
      : await this.dependencies.loadAuthoritativeRecord(operation);
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
    const encrypted = await this.dependencies.encryptEvent(event, keyEpoch);
    return {
      partitionKey,
      keyEpoch,
      eventSchemaVersion: this.dependencies.eventSchemaVersion,
      objects: [{ objectKey, objectKind: 'EVENT', bytes: encrypted }],
    };
  }
}
