import { SyncError, isSyncError } from '../../errors';
import {
  scheduleOutboxFailure,
  type OutboxRepository,
  type SyncOperation,
  type SyncOperationState,
} from '../../outbox';
import type { SyncApiClient } from '../api/SyncApiClient';
import type { SyncCommitResult, SyncOperationObject } from '../api/SyncApiTypes';
import type { PreparedMediaPointer } from '../../outbox/SyncOperation';
import type { SyncRetainedMediaObject } from '../api/SyncApiTypes';
import type { SyncInvariantValidator } from '../domain/SyncInvariantValidator';
import type { PersistentSafetyStopStore } from '../safety/PersistentSafetyStopStore';
import { BoundedObjectTransfer, sha256Hex, type TransferObject } from './BoundedObjectTransfer';
import type { OperationAcknowledgmentStore } from './PersistentOperationAcknowledgmentStore';
import { NOOP_TELEMETRY, type Telemetry } from '../../../infrastructure/telemetry/Telemetry';
import { NOOP_SYNC_FAULT_INJECTOR, type SyncFaultInjector } from '../faults/SyncFaultInjector';
import { InjectedSyncCrash } from '../faults/SyncFaultInjector';

export interface PreparedSyncOperation {
  partitionKey: string;
  keyEpoch: number;
  eventSchemaVersion: number;
  objects: Array<TransferObject & { objectKind: SyncOperationObject['objectKind'] }>;
  canonicalPayload?: unknown | null;
  mediaPointers?: PreparedMediaPointer[];
  retainedMediaObjects?: SyncRetainedMediaObject[];
}

export interface SyncOperationPreparer {
  prepare(operation: SyncOperation): Promise<PreparedSyncOperation>;
}

export interface SyncConflictRecorder {
  record(operation: SyncOperation, remoteVersion: number): Promise<void>;
}

const entryMediaCounts = (
  operation: SyncOperation,
  payload: unknown | null | undefined,
): { photoCount: number; recordingCount: number } | undefined => {
  if (operation.recordType !== 'ENTRY' || operation.operationType !== 'UPSERT') return undefined;
  const entry = (payload || {}) as {
    photoUris?: unknown[];
    audioUri?: unknown;
    blocks?: Array<{ audioUri?: unknown }>;
  };
  return {
    photoCount: Array.isArray(entry.photoUris) ? entry.photoUris.length : 0,
    recordingCount:
      (typeof entry.audioUri === 'string' && entry.audioUri ? 1 : 0) +
      (Array.isArray(entry.blocks)
        ? entry.blocks.filter((block) => typeof block?.audioUri === 'string' && block.audioUri)
            .length
        : 0),
  };
};

export interface SyncOperationProcessorOptions {
  accountId: string;
  deviceId: string;
  protocolVersion: number;
  workerId: string;
  leaseDurationMs?: number;
  now?: () => number;
  random?: () => number;
}

const patchWithoutState = (
  patch: Partial<SyncOperation> & { state: SyncOperationState },
) => {
  const { state: _state, ...rest } = patch;
  return rest;
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return typeof btoa === 'function'
    ? btoa(binary)
    : Buffer.from(binary, 'binary').toString('base64');
};

export class SyncOperationProcessor {
  private readonly now: () => number;
  private readonly leaseDurationMs: number;

  constructor(
    private readonly outbox: OutboxRepository,
    private readonly api: Pick<
      SyncApiClient,
      'initiateOperation' | 'commitOperation' | 'getOperation'
    >,
    private readonly transfer: BoundedObjectTransfer,
    private readonly preparer: SyncOperationPreparer,
    private readonly acknowledgments: OperationAcknowledgmentStore,
    private readonly conflicts: SyncConflictRecorder,
    private readonly validator: SyncInvariantValidator,
    private readonly safetyStop: PersistentSafetyStopStore,
    private readonly options: SyncOperationProcessorOptions,
    private readonly telemetry: Telemetry = NOOP_TELEMETRY,
    private readonly faults: SyncFaultInjector = NOOP_SYNC_FAULT_INJECTOR,
  ) {
    this.now = options.now || Date.now;
    this.leaseDurationMs = options.leaseDurationMs || 30_000;
  }

  async runOnce(): Promise<boolean> {
    if (await this.safetyStop.get(this.options.accountId)) return false;
    const claimed = await this.outbox.claimNextRunnable({
      accountId: this.options.accountId,
      workerId: this.options.workerId,
      now: this.now(),
      leaseDurationMs: this.leaseDurationMs,
    });
    if (!claimed) return false;
    const span = this.telemetry.startSpan('outbox.operation', {
      operation_type: claimed.operationType,
      record_type: claimed.recordType,
      outbox_state: claimed.state,
    });
    const leaseRenewal = setInterval(() => {
      void this.outbox
        .renewLease(
          claimed.operationId,
          this.options.workerId,
          this.now() + this.leaseDurationMs,
        )
        .catch(() => undefined);
    }, Math.max(1_000, Math.floor(this.leaseDurationMs / 3)));
    try {
      this.validator.validateOperation(claimed, this.options.accountId, this.options.deviceId);
      await this.process(claimed);
      this.telemetry.counter('deardiary.sync.push.success', 1, {
        operation_type: claimed.operationType,
      });
      span.end();
    } catch (error) {
      if (error instanceof InjectedSyncCrash) throw error;
      const typed = isSyncError(error)
        ? error
        : new SyncError({ code: 'UNKNOWN', retryable: true, safetyRelevant: false, cause: error });
      this.telemetry.counter('deardiary.sync.push.failure', 1, {
        error_code: typed.code,
        retryable: typed.retryable,
      });
      if (typed.code === 'INVARIANT_VIOLATION')
        this.telemetry.counter('deardiary.sync.integrity.invariant_failure', 1);
      span.end(typed.code);
      await this.handleFailure(claimed, typed);
    } finally {
      clearInterval(leaseRenewal);
    }
    return true;
  }

  private async process(initial: SyncOperation): Promise<void> {
    let operation = initial;
    if (operation.state === 'RETRY_WAIT') {
      const resumeState: SyncOperationState =
        operation.remoteSequence !== undefined
          ? 'COMMITTED'
          : operation.encryptedEventObjectKey
            ? 'UPLOADING'
            : 'PREPARING';
      operation = await this.outbox.transition(
        operation.operationId,
        'RETRY_WAIT',
        resumeState,
        {},
        this.options.workerId,
      );
    }
    if (operation.state === 'PENDING') {
      operation = await this.outbox.transition(
        operation.operationId,
        'PENDING',
        'PREPARING',
        {},
        this.options.workerId,
      );
    }

    let prepared: PreparedSyncOperation | undefined;
    if (operation.state === 'PREPARING' || operation.state === 'UPLOADING') {
      prepared = await this.preparer.prepare(operation);
      const event = prepared.objects.find((object) => object.objectKind === 'EVENT');
      if (!event) throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
      const eventSha256 = await sha256Hex(event.bytes);
      if (operation.encryptedEventSha256 && operation.encryptedEventSha256 !== eventSha256) {
        throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
      }
      if (operation.state === 'PREPARING') {
        operation = await this.outbox.transition(
          operation.operationId,
          'PREPARING',
          'UPLOADING',
          {
            encryptedEventObjectKey: event.objectKey,
            encryptedEventSha256: eventSha256,
            encryptedEventSizeBytes: event.bytes.byteLength,
            encryptedEventSchemaVersion: prepared.eventSchemaVersion,
            keyEpoch: prepared.keyEpoch,
            partitionKey: prepared.partitionKey,
            preparedCanonicalPayload: prepared.canonicalPayload,
            preparedMediaPointers: prepared.mediaPointers || [],
            retainedMediaObjects: prepared.retainedMediaObjects || [],
            preparedObjects: await Promise.all(
              prepared.objects.map(async (object) => ({
                objectKey: object.objectKey,
                objectKind: object.objectKind,
                sha256: await sha256Hex(object.bytes),
                sizeBytes: object.bytes.byteLength,
                encryptedBase64: bytesToBase64(object.bytes),
              })),
            ),
          },
          this.options.workerId,
        );
      }
      const objects = await Promise.all(
        prepared.objects.map(async (object) => ({
          objectKey: object.objectKey,
          objectKind: object.objectKind,
          sha256: await sha256Hex(object.bytes),
          sizeBytes: object.bytes.byteLength,
        })),
      );
      await this.faults.hit('BEFORE_UPLOAD_INITIATE');
      const initiated = await this.api.initiateOperation({
        operationId: operation.operationId,
        deviceId: operation.deviceId,
        recordType: operation.recordType,
        recordId: operation.recordId,
        operationType: operation.operationType,
        baseRecordVersion: operation.baseRecordVersion,
        protocolVersion: this.options.protocolVersion,
        eventSchemaVersion: prepared.eventSchemaVersion,
        keyEpoch: prepared.keyEpoch,
        partitionKey: prepared.partitionKey,
        objects,
        retainedMediaObjects: prepared.retainedMediaObjects || [],
        entryMediaCounts: entryMediaCounts(operation, prepared.canonicalPayload),
      });
      await this.faults.hit('AFTER_UPLOAD_INITIATE');
      await this.faults.hit('DURING_OBJECT_UPLOAD');
      await this.transfer.upload(prepared.objects, initiated.uploads);
      await this.faults.hit('AFTER_OBJECT_UPLOAD_BEFORE_LOCAL_PERSIST');
      operation = await this.outbox.transition(
        operation.operationId,
        'UPLOADING',
        'READY_TO_COMMIT',
        {},
        this.options.workerId,
      );
    }

    if (operation.state === 'READY_TO_COMMIT') {
      operation = await this.outbox.transition(
        operation.operationId,
        'READY_TO_COMMIT',
        'COMMITTING',
        {},
        this.options.workerId,
      );
    }
    if (operation.state === 'COMMITTING') {
      const result = await this.commitOrReconcile(operation.operationId);
      operation = await this.outbox.transition(
        operation.operationId,
        'COMMITTING',
        'COMMITTED',
        {
          remoteSequence: result.sequence,
          remoteRecordVersion: result.recordVersion,
        },
        this.options.workerId,
      );
    }
    if (operation.state === 'COMMITTED') {
      this.validator.validateOperation(operation, this.options.accountId, this.options.deviceId);
      await this.faults.hit('AFTER_COMMIT_RESPONSE_BEFORE_LOCAL_ACK');
      await this.acknowledgments.acknowledge(operation, {
        status: 'COMMITTED',
        operationId: operation.operationId,
        sequence: operation.remoteSequence!,
        recordVersion: operation.remoteRecordVersion!,
      });
    }
  }

  private async commitOrReconcile(operationId: string): Promise<SyncCommitResult> {
    const commitSpan = this.telemetry.startSpan('operation.commit');
    try {
      await this.faults.hit('BEFORE_REMOTE_COMMIT');
      const result = await this.api.commitOperation(operationId);
      await this.faults.hit('AFTER_REMOTE_COMMIT_BEFORE_RESPONSE');
      commitSpan.end();
      return result;
    } catch (error) {
      if (error instanceof InjectedSyncCrash) throw error;
      const typed = isSyncError(error)
        ? error
        : new SyncError({ code: 'UNKNOWN', retryable: true, safetyRelevant: false, cause: error });
      if (!typed.retryable && typed.code !== 'REQUEST_TIMEOUT') throw typed;
      commitSpan.end(typed.code);
      const reconcileSpan = this.telemetry.startSpan('operation.reconcile');
      const status = await this.api.getOperation(operationId);
      if (
        status.status === 'COMMITTED' &&
        status.sequence !== null &&
        status.recordVersion !== null
      ) {
        reconcileSpan.end();
        return {
          status: status.status,
          operationId,
          sequence: status.sequence,
          recordVersion: status.recordVersion,
        };
      }
      reconcileSpan.end(typed.code);
      throw typed;
    }
  }

  private async handleFailure(operation: SyncOperation, error: SyncError): Promise<void> {
    const current = await this.outbox.getById(operation.operationId);
    if (!current || current.state === 'ACKNOWLEDGED' || current.state === 'SUPERSEDED') return;
    const failure = scheduleOutboxFailure(current, error, this.now(), this.options.random);
    if (failure.state === 'CONFLICT') {
      await this.conflicts.record(
        current,
        current.remoteRecordVersion || current.baseRecordVersion + 1,
      );
    }
    if (failure.state === 'SAFETY_STOP') {
      await this.safetyStop.engage(current.accountId, error.code, `operation:${error.code}`);
    }
    await this.outbox.transition(
      current.operationId,
      current.state,
      failure.state,
      patchWithoutState(failure),
      current.leaseOwner,
    );
  }
}
