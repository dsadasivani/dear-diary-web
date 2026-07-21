import type {
  Diary,
  Entry,
  Note,
  AppSettings,
  SyncDomainEvent,
  SyncAffectedRecordVersion,
  SyncEventOperation,
  SyncRecordType,
  UserProfile,
} from '../types';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type SyncRecordPayload = Diary | Entry | Note | AppSettings | UserProfile;

const payloadMatchesRecord = (
  recordType: SyncRecordType,
  recordId: string,
  payload: SyncRecordPayload | null,
): boolean => {
  if (!payload) return false;
  if (recordType === 'settings') return recordId === 'settings';
  if (recordType === 'profile') return recordId === 'profile';
  return 'id' in payload && payload.id === recordId;
};

export interface CreateSyncDomainEventInput {
  accountId: string;
  deviceId: string;
  recordType: SyncRecordType;
  operation: SyncEventOperation;
  recordId: string;
  baseRecordVersion: number;
  payload: SyncRecordPayload | null;
  eventId?: string;
  createdAt?: string;
  affectedRecords?: Array<Omit<SyncAffectedRecordVersion, 'recordVersion'>>;
}

export const syncRecordKey = (recordType: SyncRecordType, recordId: string): string =>
  `${recordType}:${recordId}`;

export const createSyncDomainEvent = (input: CreateSyncDomainEventInput): SyncDomainEvent => {
  if (!input.accountId || !input.deviceId || !input.recordId) {
    throw new Error('Sync event identity is incomplete.');
  }
  if (!Number.isInteger(input.baseRecordVersion) || input.baseRecordVersion < 0) {
    throw new Error('Sync event base record version must be a non-negative integer.');
  }
  if (
    input.operation === 'upsert' &&
    !payloadMatchesRecord(input.recordType, input.recordId, input.payload)
  ) {
    throw new Error('Sync upsert payload must match the event record ID.');
  }
  if (input.operation === 'delete' && input.payload !== null) {
    throw new Error('Sync delete events cannot contain a record payload.');
  }
  const affectedRecords = (input.affectedRecords || []).map((record) => {
    if (
      !record.recordId ||
      !Number.isInteger(record.baseRecordVersion) ||
      record.baseRecordVersion < 0
    ) {
      throw new Error('Affected sync record version is invalid.');
    }
    return { ...record, recordVersion: record.baseRecordVersion + 1 };
  });

  return {
    version: 1,
    eventId: input.eventId || crypto.randomUUID(),
    accountId: input.accountId,
    deviceId: input.deviceId,
    createdAt: input.createdAt || new Date().toISOString(),
    recordType: input.recordType,
    operation: input.operation,
    recordId: input.recordId,
    baseRecordVersion: input.baseRecordVersion,
    recordVersion: input.baseRecordVersion + 1,
    affectedRecords,
    payload: input.payload,
  } as SyncDomainEvent;
};

export const encodeSyncDomainEvent = (event: SyncDomainEvent): Uint8Array =>
  encoder.encode(JSON.stringify(event));

export const decodeSyncDomainEvent = (bytes: Uint8Array): SyncDomainEvent => {
  const event = JSON.parse(decoder.decode(bytes)) as SyncDomainEvent;
  if (
    event.version !== 1 ||
    !event.eventId ||
    !event.accountId ||
    !event.deviceId ||
    !event.recordId ||
    !['diary', 'entry', 'note', 'settings', 'profile'].includes(event.recordType) ||
    !['upsert', 'delete'].includes(event.operation) ||
    !Number.isInteger(event.baseRecordVersion) ||
    event.baseRecordVersion < 0 ||
    event.recordVersion !== event.baseRecordVersion + 1
  ) {
    throw new Error('Encrypted sync event is invalid or unsupported.');
  }
  if (
    event.operation === 'upsert' &&
    !payloadMatchesRecord(event.recordType, event.recordId, event.payload)
  ) {
    throw new Error('Encrypted sync event payload does not match its record ID.');
  }
  if (event.operation === 'delete' && event.payload !== null) {
    throw new Error('Encrypted sync delete event contains an unexpected payload.');
  }
  for (const affected of event.affectedRecords || []) {
    if (
      !affected.recordId ||
      !['diary', 'entry', 'note', 'settings', 'profile'].includes(affected.recordType) ||
      affected.recordVersion !== affected.baseRecordVersion + 1
    )
      throw new Error('Encrypted sync event affected-record metadata is invalid.');
  }
  return event;
};
