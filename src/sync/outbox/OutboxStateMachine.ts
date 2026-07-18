import { SyncError } from '../errors';
import type { SyncOutboxStateV2 } from './SyncOutboxOperationV2';

export const ALLOWED_OUTBOX_V2_TRANSITIONS: Readonly<
  Record<SyncOutboxStateV2, ReadonlySet<SyncOutboxStateV2>>
> = {
  PENDING: new Set([
    'PREPARING',
    'BLOCKED_AUTH',
    'BLOCKED_DEVICE',
    'BLOCKED_UPGRADE',
    'SAFETY_STOP',
    'SUPERSEDED',
  ]),
  PREPARING: new Set([
    'UPLOADING',
    'READY_TO_COMMIT',
    'RETRY_WAIT',
    'CONFLICT',
    'BLOCKED_AUTH',
    'BLOCKED_DEVICE',
    'BLOCKED_UPGRADE',
    'SAFETY_STOP',
    'SUPERSEDED',
  ]),
  UPLOADING: new Set([
    'READY_TO_COMMIT',
    'RETRY_WAIT',
    'BLOCKED_AUTH',
    'BLOCKED_DEVICE',
    'BLOCKED_UPGRADE',
    'SAFETY_STOP',
  ]),
  READY_TO_COMMIT: new Set([
    'COMMITTING',
    'RETRY_WAIT',
    'CONFLICT',
    'BLOCKED_AUTH',
    'BLOCKED_DEVICE',
    'BLOCKED_UPGRADE',
    'SAFETY_STOP',
    'SUPERSEDED',
  ]),
  COMMITTING: new Set([
    'COMMITTED',
    'RETRY_WAIT',
    'CONFLICT',
    'BLOCKED_AUTH',
    'BLOCKED_DEVICE',
    'BLOCKED_UPGRADE',
    'SAFETY_STOP',
  ]),
  COMMITTED: new Set(['ACKNOWLEDGED', 'RETRY_WAIT', 'SAFETY_STOP']),
  ACKNOWLEDGED: new Set(),
  RETRY_WAIT: new Set([
    'PREPARING',
    'UPLOADING',
    'READY_TO_COMMIT',
    'COMMITTING',
    'COMMITTED',
    'BLOCKED_AUTH',
    'BLOCKED_DEVICE',
    'BLOCKED_UPGRADE',
    'SAFETY_STOP',
    'SUPERSEDED',
  ]),
  CONFLICT: new Set(['PENDING', 'SUPERSEDED', 'SAFETY_STOP']),
  BLOCKED_AUTH: new Set([
    'PENDING',
    'PREPARING',
    'UPLOADING',
    'READY_TO_COMMIT',
    'COMMITTING',
    'SAFETY_STOP',
    'SUPERSEDED',
  ]),
  BLOCKED_DEVICE: new Set(['SAFETY_STOP', 'SUPERSEDED']),
  BLOCKED_UPGRADE: new Set(['PENDING', 'PREPARING', 'SAFETY_STOP', 'SUPERSEDED']),
  SAFETY_STOP: new Set(['PENDING', 'SUPERSEDED']),
  SUPERSEDED: new Set(),
};

export const isAllowedOutboxTransition = (
  from: SyncOutboxStateV2,
  to: SyncOutboxStateV2,
): boolean => ALLOWED_OUTBOX_V2_TRANSITIONS[from].has(to);

export const assertAllowedOutboxTransition = (
  from: SyncOutboxStateV2,
  to: SyncOutboxStateV2,
): void => {
  if (!isAllowedOutboxTransition(from, to)) {
    throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
  }
};
