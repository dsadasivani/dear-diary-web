import assert from 'node:assert/strict';
import test from 'node:test';
import { diaryRepository } from '../repositories';
import { exportEncryptedBackup, importEncryptedBackup } from './manualBackup';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

test('round-trips a cached profile avatar through encrypted export and import', async () => {
  Object.defineProperty(globalThis, 'localStorage', { value: new MemoryStorage(), configurable: true });
  await diaryRepository.initialize();
  const sourceProfile = {
    ...(await diaryRepository.getUserProfile()),
    name: 'Portable Writer',
    avatarUri: 'data:image/jpeg;base64,aGVsbG8=',
  };
  await diaryRepository.saveUserProfile(sourceProfile);
  const encrypted = await exportEncryptedBackup('correct horse battery staple');

  await diaryRepository.saveUserProfile({
    ...sourceProfile,
    name: 'Changed Writer',
    avatarUri: undefined,
  });
  assert.equal(await importEncryptedBackup(encrypted, 'correct horse battery staple'), true);

  const restored = await diaryRepository.getUserProfile();
  assert.equal(restored.name, 'Portable Writer');
  assert.equal(restored.avatarUri, sourceProfile.avatarUri);
});
