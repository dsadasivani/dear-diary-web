import assert from 'node:assert/strict';
import test from 'node:test';
import type { DiaryRepository, RepositorySnapshot } from '../repositories/DiaryRepository';
import type { LocalSyncAccountState, PartitionHydrationState } from '../types';
import { RemotePullService, type RemotePullRuntime } from './RemotePullService';
import type { SupabaseControlPlaneClient } from './supabaseControlPlane';
import type { SyncSecrets } from './syncSecrets';

const state = (partitionedSyncEnabled: boolean): LocalSyncAccountState => ({
  accountId: 'account-1',
  deviceId: 'device-1',
  deviceRole: 'primary_mobile',
  googleUserId: 'google-1',
  googleEmail: 'writer@example.com',
  devicePublicKey: '{}',
  recoveryKeyDriveFileId: 'key-1',
  latestSnapshotDriveFileId: 'snapshot-1',
  currentSyncSequence: 3,
  partitionedSyncEnabled,
  linkedAt: 1,
});

const secrets: SyncSecrets = {
  version: 1,
  accountId: 'account-1',
  accountRootKey: new Uint8Array(32),
  devicePrivateKeyJwk: '{}',
  supabaseSession: { accessToken: 'token', refreshToken: 'refresh' },
};

const runtime = (
  accountState: LocalSyncAccountState,
  controlPlane: SupabaseControlPlaneClient,
): RemotePullRuntime => ({
  state: accountState,
  secrets,
  googleSession: {
    userId: 'google-1',
    email: 'writer@example.com',
    displayName: null,
    accessToken: 'drive-token',
  },
  controlPlane,
});

const createService = (repository: DiaryRepository) =>
  new RemotePullService(repository, {
    loadSecrets: async () => secrets,
    saveSecrets: async () => undefined,
  });

test('global pull advances the device cursor when no remote objects remain', async () => {
  const accountState = state(false);
  let cursorSequence = -1;
  const repository = {
    getLocalSyncAccountState: async () => accountState,
  } as unknown as DiaryRepository;
  const controlPlane = {
    listSyncObjectsAfter: async () => [],
    updateDeviceCursor: async (input: { lastAppliedSequence: number }) => {
      cursorSequence = input.lastAppliedSequence;
      return {};
    },
  } as unknown as SupabaseControlPlaneClient;

  await createService(repository).pull(runtime(accountState, controlPlane));

  assert.equal(cursorSequence, 3);
});

test('partitioned pull repairs a recent event-only partition from existing local records', async () => {
  const accountState = state(true);
  const hydration = new Map<string, PartitionHydrationState>([
    ['core', { partitionKey: 'core', status: 'hydrated', lastAppliedSequence: 3 }],
  ]);
  const partitionCursorUpdates: Array<{ partitionKey: string; lastAppliedSequence: number }> = [];
  const repository = {
    getLocalSyncAccountState: async () => accountState,
    saveLocalSyncAccountState: async () => undefined,
    getPartitionHydrationState: async (partitionKey: string) =>
      hydration.get(partitionKey) || {
        partitionKey,
        status: 'not_available',
        lastAppliedSequence: 0,
      },
    listAvailableArchiveMonths: async () =>
      Array.from(hydration.values()).filter((item) => item.partitionKey !== 'core'),
    markPartitionHydrated: async (partitionKey: string, lastAppliedSequence: number) => {
      hydration.set(partitionKey, { partitionKey, status: 'hydrated', lastAppliedSequence });
    },
    exportSnapshot: async () =>
      ({
        entries: [{ date: '2026-07-05' }],
        notes: [],
      }) as unknown as RepositorySnapshot,
  } as unknown as DiaryRepository;
  const controlPlane = {
    listSyncObjectsAfter: async () => [],
    listPartitionHeads: async () => [
      {
        partitionKey: 'month:2026-07',
        latestEventSequence: 8,
        latestSnapshotSequence: 0,
      },
    ],
    listPartitionObjectsAfter: async () => [],
    updatePartitionCursor: async (input: { partitionKey: string; lastAppliedSequence: number }) => {
      partitionCursorUpdates.push(input);
      return {};
    },
    updateDeviceCursor: async () => ({}),
  } as unknown as SupabaseControlPlaneClient;
  const service = new RemotePullService(repository, {
    now: () => Date.parse('2026-07-12T00:00:00.000Z'),
    loadSecrets: async () => secrets,
    saveSecrets: async () => undefined,
  });

  await service.pull(runtime(accountState, controlPlane));

  assert.equal(hydration.get('month:2026-07')?.lastAppliedSequence, 3);
  assert.deepEqual(partitionCursorUpdates, [
    {
      partitionKey: 'month:2026-07',
      lastAppliedSequence: 3,
      deviceId: 'device-1',
      hydratedAt: '2026-07-12T00:00:00.000Z',
    },
  ]);
});
