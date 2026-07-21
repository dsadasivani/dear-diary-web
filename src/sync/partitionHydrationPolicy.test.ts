import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldBackgroundHydrateArchive } from './partitionHydrationPolicy';

test('allows archive hydration on Wi-Fi with enough power', () => {
  assert.deepEqual(
    shouldBackgroundHydrateArchive({
      isOnline: true,
      isWifi: true,
      isCharging: false,
      batteryLevel: 0.8,
    }),
    { allowed: true, reason: 'allowed' },
  );
});

test('blocks background archive hydration on mobile data by default', () => {
  assert.equal(
    shouldBackgroundHydrateArchive({
      isOnline: true,
      isWifi: false,
      isCharging: true,
    }).reason,
    'mobile_data_blocked',
  );
});

test('blocks background archive hydration on low battery and high storage pressure', () => {
  assert.equal(
    shouldBackgroundHydrateArchive({
      isOnline: true,
      isWifi: true,
      isCharging: false,
      batteryLevel: 0.2,
    }).reason,
    'battery_saver',
  );
  assert.equal(
    shouldBackgroundHydrateArchive({
      isOnline: true,
      isWifi: true,
      isCharging: true,
      storagePressure: 'high',
    }).reason,
    'storage_pressure',
  );
});
