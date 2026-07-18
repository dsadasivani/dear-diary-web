import assert from 'node:assert/strict';
import test from 'node:test';
import { zipSync } from 'fflate';
import type { BackupManifest } from '../types';
import { diaryRepository } from '../repositories';
import {
  createBackupBundle,
  restoreBackupBundle,
  validateBackupBundleBytes,
} from './backupSnapshot';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number {
    return this.values.size;
  }
  clear(): void {
    this.values.clear();
  }
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const encoder = new TextEncoder();

const checksum = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
};

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

test('continues to validate legacy schema v1 backups', async () => {
  const dataJson = JSON.stringify(payload);
  const bytes = zipSync({
    'manifest.json': encoder.encode(
      JSON.stringify(manifest({ checksum: await checksum(dataJson) })),
    ),
    'data.json': encoder.encode(dataJson),
  });
  const validated = await validateBackupBundleBytes(bytes);
  assert.equal(validated.manifest.schemaVersion, 1);
  assert.equal(validated.payload.version, '2.0.0');
});

test('validates portable schema v2 without device security metadata', async () => {
  const portablePayload = {
    ...payload,
    version: '3.0.0',
    security: undefined,
    driveBackupSettings: undefined,
    backupSchedule: {
      mode: 'weekly',
      localTime: '03:15',
      weeklyDay: 1,
      network: 'wifi',
      timezone: 'Asia/Calcutta',
    },
  };
  const dataJson = JSON.stringify(portablePayload);
  const bytes = zipSync({
    'manifest.json': encoder.encode(
      JSON.stringify(
        manifest({
          schemaVersion: 2,
          checksum: await checksum(dataJson),
          deviceId: 'device-a',
          contentRevision: 7,
        }),
      ),
    ),
    'data.json': encoder.encode(dataJson),
  });
  const validated = await validateBackupBundleBytes(bytes);
  assert.equal(validated.manifest.contentRevision, 7);
  assert.equal(validated.payload.security, undefined);
});

test('round-trips a cached profile avatar through the Drive backup bundle', async () => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: new MemoryStorage(),
    configurable: true,
  });
  await diaryRepository.initialize();
  const sourceProfile = {
    ...(await diaryRepository.getUserProfile()),
    name: 'Backup Writer',
    avatarUri: 'data:image/png;base64,aGVsbG8=',
  };
  await diaryRepository.saveUserProfile(sourceProfile);
  const bundle = await createBackupBundle({ deviceId: 'device-test', contentRevision: 1 });

  await diaryRepository.saveUserProfile({
    ...sourceProfile,
    name: 'Changed Writer',
    avatarUri: undefined,
  });
  await restoreBackupBundle(bundle.bytes);

  const restored = await diaryRepository.getUserProfile();
  assert.equal(restored.name, 'Backup Writer');
  assert.equal(restored.avatarUri, sourceProfile.avatarUri);
});
