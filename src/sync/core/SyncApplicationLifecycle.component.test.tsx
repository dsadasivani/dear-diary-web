import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  signOutGoogleAuth: vi.fn<() => Promise<void>>(),
  clearSyncSecrets: vi.fn<() => Promise<void>>(),
  clearSyncLocalCache: vi.fn<() => Promise<void>>(),
}));

vi.mock('../../utils/googleAuth', () => ({
  signOutGoogleAuth: mocks.signOutGoogleAuth,
}));

vi.mock('../syncSecrets', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../syncSecrets')>()),
  clearSyncSecrets: mocks.clearSyncSecrets,
}));

vi.mock('./clearSyncLocalCache', () => ({
  clearSyncLocalCache: mocks.clearSyncLocalCache,
}));

vi.mock('./companionPairing', () => ({
  signWithDeviceBundle: vi.fn(),
}));

import type { LocalDataStore } from '../../platform/storage';
import type { DiaryRepository } from '../../repositories/DiaryRepository';
import type { EventSyncEngine } from '../eventSyncEngine';
import type { OutboxRepository } from '../outbox';
import { SyncApplicationLifecycle } from './SyncApplicationLifecycle';

describe('SyncApplicationLifecycle device revocation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('signs out the local Google session before clearing revoked-device credentials', async () => {
    const cleanupOrder: string[] = [];
    mocks.signOutGoogleAuth.mockImplementation(async () => {
      cleanupOrder.push('google-session');
    });
    mocks.clearSyncSecrets.mockImplementation(async () => {
      cleanupOrder.push('sync-secrets');
    });
    mocks.clearSyncLocalCache.mockImplementation(async () => {
      cleanupOrder.push('sync-cache');
    });

    const repository = {
      clearLocalSyncAccountState: vi.fn(async () => {
        cleanupOrder.push('sync-account');
      }),
      resetContent: vi.fn(async () => {
        cleanupOrder.push('content');
      }),
    } as unknown as DiaryRepository;
    const engine = {
      installRuntimeDelegate: vi.fn(),
    } as unknown as EventSyncEngine;
    const lifecycle = new SyncApplicationLifecycle(
      {} as LocalDataStore,
      repository,
      {} as OutboxRepository,
      engine,
    );

    await (
      lifecycle as unknown as { handleDeviceRevoked: () => Promise<void> }
    ).handleDeviceRevoked();

    expect(cleanupOrder).toEqual([
      'google-session',
      'sync-secrets',
      'sync-account',
      'sync-cache',
      'content',
    ]);
    expect(engine.installRuntimeDelegate).toHaveBeenCalledWith(null);
  });
});
