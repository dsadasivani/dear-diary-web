import { SyncError } from '../../errors';
import type { SyncOutboxOperationV2 } from '../../outbox';
import type { SyncV2RemoteEvent } from '../api/SyncV2ApiTypes';

export interface DecryptedSyncV2EventMetadata {
  accountId: string;
  operationId: string;
  recordType: SyncV2RemoteEvent['recordType'];
  recordId: string;
  operationType: SyncV2RemoteEvent['operationType'];
  recordVersion: number;
  keyEpoch: number;
}

const invariant = (condition: unknown): void => {
  if (!condition) throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
};

export class SyncInvariantValidator {
  validateSequences(localSequence: number, remoteSequence?: number): void {
    invariant(Number.isSafeInteger(localSequence) && localSequence >= 0);
    invariant(remoteSequence === undefined || (Number.isSafeInteger(remoteSequence) && remoteSequence >= localSequence));
  }

  validateOperation(operation: SyncOutboxOperationV2, accountId: string, deviceId: string): void {
    invariant(operation.accountId === accountId);
    invariant(operation.deviceId === deviceId);
    invariant(operation.baseRecordVersion >= 0);
    if (operation.state === 'COMMITTED' || operation.state === 'ACKNOWLEDGED') {
      invariant(operation.remoteSequence !== undefined);
      invariant(operation.remoteRecordVersion !== undefined);
    }
  }

  validateReplayPage(events: SyncV2RemoteEvent[], afterSequence: number): void {
    let expected = afterSequence + 1;
    events.forEach(event => {
      invariant(event.sequence === expected);
      invariant(event.recordVersion >= 1);
      expected += 1;
    });
  }

  validateEventEnvelope(
    event: SyncV2RemoteEvent,
    decrypted: DecryptedSyncV2EventMetadata,
    accountId: string,
  ): void {
    invariant(decrypted.accountId === accountId);
    invariant(decrypted.operationId === event.operationId);
    invariant(decrypted.recordType === event.recordType);
    invariant(decrypted.recordId === event.recordId);
    invariant(decrypted.operationType === event.operationType);
    invariant(decrypted.recordVersion === event.recordVersion);
    invariant(decrypted.keyEpoch === event.keyEpoch);
  }

  validateCursorAdvance(previous: number, next: number, lastAppliedInTransaction: number): void {
    invariant(next >= previous);
    invariant(next === lastAppliedInTransaction);
  }

  validateExclusiveOperationCount(activeRecoveryOrRotationCount: number): void {
    invariant(Number.isSafeInteger(activeRecoveryOrRotationCount));
    invariant(activeRecoveryOrRotationCount >= 0 && activeRecoveryOrRotationCount <= 1);
  }

  validateDestructiveMaintenance(safetyStopEngaged: boolean, serverAuthorized: boolean): void {
    invariant(!safetyStopEngaged);
    invariant(serverAuthorized);
  }
}
