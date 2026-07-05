import assert from 'node:assert/strict';
import test from 'node:test';
import { zipSync } from 'fflate';
import type { BackupManifest } from '../types';
import { validateBackupBundleBytes } from './backupSnapshot';

const encoder = new TextEncoder();

const payload = {
  version: '2.0.0',
  exportedAt: '2026-07-04T00:00:00.000Z',
  diaries: [],
  entries: [],
  notes: [],
  settings: { remindersEnabled: false, reminderTime: '20:00', theme: 'light' },
  userProfile: {
    name: 'Writer',
    email: '',
    bio: '',
    avatarEmoji: 'W',
    avatarColor: '#8A3D55',
    writingGoal: 100,
    joinedDate: 'July 2026',
  },
  security: {
    isPinCreated: false,
    pinHash: '',
    pinSalt: '',
    isBiometricsEnabled: false,
    isLocked: true,
  },
  driveBackupSettings: {},
  mediaAssets: [],
};

const manifest = (overrides: Partial<BackupManifest> = {}): BackupManifest => ({
  schemaVersion: 1,
  createdAt: '2026-07-04T00:00:00.000Z',
  appVersion: '0.0.0',
  storageSchemaVersion: 1,
  counts: { diaries: 0, entries: 0, notes: 0, media: 0 },
  mediaCount: 0,
  totalBytes: 0,
  checksum: 'not-the-real-checksum',
  ...overrides,
});

test('rejects a backup missing required files', async () => {
  const bytes = zipSync({ 'data.json': encoder.encode(JSON.stringify(payload)) });
  await assert.rejects(validateBackupBundleBytes(bytes), /missing required files/i);
});

test('rejects an unsupported backup schema before restore', async () => {
  const bytes = zipSync({
    'manifest.json': encoder.encode(JSON.stringify(manifest({ schemaVersion: 99 }))),
    'data.json': encoder.encode(JSON.stringify(payload)),
  });
  await assert.rejects(validateBackupBundleBytes(bytes), /unsupported backup schema version 99/i);
});

test('rejects backup data with a checksum mismatch', async () => {
  const bytes = zipSync({
    'manifest.json': encoder.encode(JSON.stringify(manifest())),
    'data.json': encoder.encode(JSON.stringify(payload)),
  });
  await assert.rejects(validateBackupBundleBytes(bytes), /checksum did not match/i);
});
