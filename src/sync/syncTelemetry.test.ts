import assert from 'node:assert/strict';
import test from 'node:test';
import { emitSyncTelemetry, setSyncTelemetrySink } from './syncTelemetry';

test('emits sync telemetry to an injectable sink', () => {
  const events: ReturnType<typeof emitSyncTelemetry>[] = [];
  setSyncTelemetrySink((event) => events.push(event));

  const emitted = emitSyncTelemetry('sync.test.event', { partitionKey: 'month:2026-07' }, 'warn');

  assert.equal(events.length, 1);
  assert.equal(events[0].name, 'sync.test.event');
  assert.equal(events[0].level, 'warn');
  assert.deepEqual(events[0].data, {});
  assert.equal(emitted, events[0]);
  setSyncTelemetrySink(null);
});

test('redacts sensitive identifiers and diary-shaped values', () => {
  const events: ReturnType<typeof emitSyncTelemetry>[] = [];
  setSyncTelemetrySink((event) => events.push(event));
  emitSyncTelemetry('sync.test.private', {
    accountId: 'account-private',
    title: 'private title',
    error: 'provider payload',
    errorCode: 'OFFLINE',
    retryCount: 2,
  });
  assert.deepEqual(events[0].data, { errorCode: 'OFFLINE', retryCount: 2 });
  setSyncTelemetrySink(null);
});
