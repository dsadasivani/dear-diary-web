import assert from 'node:assert/strict';
import test from 'node:test';
import { createSyncDomainEvent, decodeSyncDomainEvent, encodeSyncDomainEvent } from './domainEvents';

test('round-trips a canonical versioned sync event', () => {
  const event = createSyncDomainEvent({
    accountId: 'account-1',
    deviceId: 'device-1',
    recordType: 'note',
    operation: 'upsert',
    recordId: 'note-1',
    baseRecordVersion: 2,
    eventId: 'event-1',
    createdAt: '2026-07-05T00:00:00.000Z',
    payload: {
      id: 'note-1',
      title: 'A thought',
      body: 'Kept private.',
      isPinned: false,
      tags: [],
      createdAt: 1,
      updatedAt: 2,
    },
  });

  assert.equal(event.recordVersion, 3);
  assert.deepEqual(decodeSyncDomainEvent(encodeSyncDomainEvent(event)), event);
});

test('rejects an upsert whose payload targets another record', () => {
  assert.throws(() => createSyncDomainEvent({
    accountId: 'account-1',
    deviceId: 'device-1',
    recordType: 'note',
    operation: 'upsert',
    recordId: 'note-1',
    baseRecordVersion: 0,
    payload: {
      id: 'note-2',
      title: '',
      body: '',
      isPinned: false,
      tags: [],
      createdAt: 1,
      updatedAt: 1,
    },
  }), /record ID/);
});

test('versions child records carried by a cascade delete event', () => {
  const event = createSyncDomainEvent({
    accountId: 'account-1',
    deviceId: 'device-1',
    recordType: 'diary',
    operation: 'delete',
    recordId: 'diary-1',
    baseRecordVersion: 4,
    payload: null,
    affectedRecords: [{ recordType: 'entry', recordId: 'entry-1', baseRecordVersion: 2 }],
  });
  assert.deepEqual(event.affectedRecords, [{
    recordType: 'entry', recordId: 'entry-1', baseRecordVersion: 2, recordVersion: 3,
  }]);
  assert.deepEqual(decodeSyncDomainEvent(encodeSyncDomainEvent(event)), event);
});
