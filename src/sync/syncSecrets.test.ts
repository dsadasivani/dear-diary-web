import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getAccountRootKeyForEpoch,
  loadSyncSecrets,
  saveSyncSecrets,
  withAccountRootKeyForEpoch,
  type SyncSecretStorage,
} from './syncSecrets';

class MemorySecretStorage implements SyncSecretStorage {
  private value: string | null = null;
  async getItem(): Promise<string | null> { return this.value; }
  async setItem(_key: string, value: string): Promise<void> { this.value = value; }
  async removeItem(): Promise<void> { this.value = null; }
}

test('persists and restores account root key material through secret storage', async () => {
  const storage = new MemorySecretStorage();
  const accountRootKey = Uint8Array.from({ length: 32 }, (_, index) => index);
  await saveSyncSecrets({
    version: 1,
    accountId: 'account-1',
    accountRootKey,
    devicePrivateKeyJwk: '{"kty":"EC"}',
    supabaseSession: { accessToken: 'access', refreshToken: 'refresh', expiresAt: 123 },
  }, storage);

  const restored = await loadSyncSecrets(storage);
  assert.deepEqual(restored?.accountRootKey, accountRootKey);
  assert.equal(restored?.supabaseSession.refreshToken, 'refresh');
});

test('persists multiple epoch root keys', async () => {
  const storage = new MemorySecretStorage();
  const epoch1 = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const epoch2 = Uint8Array.from({ length: 32 }, (_, index) => index + 33);
  const secrets = withAccountRootKeyForEpoch({
    version: 1,
    accountId: 'account-1',
    accountRootKey: epoch1,
    accountRootKeys: { 1: epoch1 },
    devicePrivateKeyJwk: '{"kty":"EC"}',
    supabaseSession: { accessToken: 'access', refreshToken: 'refresh' },
  }, 2, epoch2);

  await saveSyncSecrets(secrets, storage);

  const restored = await loadSyncSecrets(storage);
  assert.deepEqual(restored?.accountRootKey, epoch2);
  assert.deepEqual(restored?.accountRootKeys?.[1], epoch1);
  assert.deepEqual(getAccountRootKeyForEpoch(restored!, 2), epoch2);
});
