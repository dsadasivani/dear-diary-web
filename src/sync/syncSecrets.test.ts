import assert from 'node:assert/strict';
import test from 'node:test';
import { loadSyncSecrets, saveSyncSecrets, type SyncSecretStorage } from './syncSecrets';

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
