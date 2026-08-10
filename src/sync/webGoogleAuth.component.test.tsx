import { beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  signOut: vi.fn(),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: {
      signOut: mocks.signOut,
    },
  })),
}));

vi.mock('./config', () => ({
  getConfiguredSupabaseAnonKey: () => 'test-anon-key',
  getConfiguredSupabaseUrl: () => 'https://sync.test.invalid',
}));

vi.mock('../platform/storage/webEncryptedKeyValueStore', () => ({
  SYNC_SECRET_STORE: 'values',
  WebEncryptedKeyValueStore: class {},
}));

import { signOutWebGoogleSync } from './webGoogleAuth';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.signOut.mockResolvedValue({ error: null });
});

test('web companion sign-out only ends the current browser session', async () => {
  await signOutWebGoogleSync();

  expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' });
});

test('web companion sign-out reports failures to the cleanup caller', async () => {
  const error = new Error('Sign-out failed');
  mocks.signOut.mockResolvedValue({ error });

  await expect(signOutWebGoogleSync()).rejects.toBe(error);
});
