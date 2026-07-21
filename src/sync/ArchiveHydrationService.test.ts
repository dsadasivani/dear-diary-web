import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DiaryRepository } from '../repositories/DiaryRepository';
import type { LocalSyncAccountState, PartitionHydrationState } from '../types';
import { ArchiveHydrationService, type ArchiveHydrationRuntime } from './ArchiveHydrationService';
import type { SupabaseControlPlaneClient } from './supabaseControlPlane';

const accountState: LocalSyncAccountState = {
  accountId: 'account-1',
  deviceId: 'device-1',
  deviceRole: 'primary_mobile',
  googleUserId: 'google-1',
  googleEmail: 'writer@example.com',
  devicePublicKey: '{}',
  recoveryKeyDriveFileId: 'recovery-1',
  latestSnapshotDriveFileId: 'snapshot-1',
  currentSyncSequence: 5,
  keyEpoch: 1,
  partitionedSyncEnabled: true,
  linkedAt: 1,
};

const createRuntime = (controlPlane: SupabaseControlPlaneClient): ArchiveHydrationRuntime => ({
  state: accountState,
  secrets: {
    version: 1,
    accountId: 'account-1',
    accountRootKey: new Uint8Array(32),
    accountRootKeys: {},
    devicePrivateKeyJwk: '{}',
    supabaseSession: {
      accessToken: 'supabase-token',
      refreshToken: 'refresh',
      expiresAt: 2_000_000_000,
    },
  },
  googleSession: {
    userId: 'google-1',
    email: 'writer@example.com',
    displayName: null,
    accessToken: 'drive-token',
  },
  controlPlane,
});

const createRepository = (
  partitions: PartitionHydrationState[],
): {
  repository: DiaryRepository;
  states: Map<string, PartitionHydrationState>;
  failedPartitions: Array<{ partitionKey: string; error: string }>;
} => {
  const states = new Map(partitions.map((partition) => [partition.partitionKey, { ...partition }]));
  const failedPartitions: Array<{ partitionKey: string; error: string }> = [];
  const repository = {
    getLocalSyncAccountState: async () => accountState,
    listAvailableArchiveMonths: async () =>
      Array.from(states.values()).map((state) => ({ ...state })),
    markPartitionHydrating: async (partitionKey: string) => {
      const current = states.get(partitionKey);
      states.set(partitionKey, {
        partitionKey,
        status: 'hydrating',
        lastAppliedSequence: current?.lastAppliedSequence || 0,
        failureCount: current?.failureCount,
        nextRetryAt: current?.nextRetryAt,
      });
    },
    markPartitionHydrated: async (partitionKey: string, sequence: number) => {
      states.set(partitionKey, {
        partitionKey,
        status: 'hydrated',
        lastAppliedSequence: sequence,
      });
    },
    markPartitionHydrationFailed: async (partitionKey: string, error: string) => {
      const current = states.get(partitionKey);
      failedPartitions.push({ partitionKey, error });
      states.set(partitionKey, {
        partitionKey,
        status: 'failed',
        lastAppliedSequence: current?.lastAppliedSequence || 0,
        failureCount: (current?.failureCount || 0) + 1,
        nextRetryAt: 31_000,
        error,
      });
    },
    getPartitionHydrationState: async (partitionKey: string) =>
      states.get(partitionKey) || {
        partitionKey,
        status: 'not_available',
        lastAppliedSequence: 0,
      },
  } as unknown as DiaryRepository;
  return { repository, states, failedPartitions };
};

test('background archive hydration processes available and retryable partitions', async () => {
  const { repository, states } = createRepository([
    { partitionKey: 'month:2026-06', status: 'available', lastAppliedSequence: 0 },
    {
      partitionKey: 'month:2026-05',
      status: 'failed',
      lastAppliedSequence: 0,
      nextRetryAt: 30_001,
    },
    {
      partitionKey: 'month:2026-04',
      status: 'failed',
      lastAppliedSequence: 0,
      nextRetryAt: 29_999,
    },
  ]);
  const hydratedPartitions: string[] = [];
  const partitionCursors: Array<{ partitionKey: string; lastAppliedSequence: number }> = [];
  const deviceCursors: number[] = [];
  const activeDeviceChecks: string[] = [];
  const controlPlane = {
    updatePartitionCursor: async (input: { partitionKey: string; lastAppliedSequence: number }) => {
      partitionCursors.push(input);
    },
    updateDeviceCursor: async (input: { lastAppliedSequence: number }) => {
      deviceCursors.push(input.lastAppliedSequence);
    },
  } as unknown as SupabaseControlPlaneClient;
  const service = new ArchiveHydrationService(repository, {
    now: () => 30_000,
    backgroundArchiveBatchSize: 2,
    getArchiveHydrationPolicyInput: async () => ({
      isOnline: true,
      isWifi: true,
      isCharging: true,
    }),
    hydrateArchivePartition: async (input) => {
      hydratedPartitions.push(input.partitionKey);
      const sequence = 100 + hydratedPartitions.length;
      await input.repository.markPartitionHydrated(input.partitionKey, sequence);
      return {
        mode: 'partitioned',
        manifest: null,
        hydratedPartitionKeys: [input.partitionKey],
        currentSyncSequence: sequence,
      };
    },
  });

  const result = await service.hydrateBackgroundArchiveOnce({
    requireOnline: () => undefined,
    openRuntime: async () => createRuntime(controlPlane),
    assertActiveDevice: async (_controlPlane, deviceId) => {
      activeDeviceChecks.push(deviceId);
    },
  });

  assert.deepEqual(result.hydratedPartitionKeys, ['month:2026-06', 'month:2026-04']);
  assert.deepEqual(hydratedPartitions, ['month:2026-06', 'month:2026-04']);
  assert.equal(states.get('month:2026-05')?.status, 'failed');
  assert.deepEqual(
    partitionCursors.map((cursor) => ({
      partitionKey: cursor.partitionKey,
      lastAppliedSequence: cursor.lastAppliedSequence,
    })),
    [
      { partitionKey: 'month:2026-06', lastAppliedSequence: 101 },
      { partitionKey: 'month:2026-04', lastAppliedSequence: 102 },
    ],
  );
  assert.deepEqual(deviceCursors, [101, 102]);
  assert.deepEqual(activeDeviceChecks, ['device-1']);
});

test('background archive hydration stops after the first failed partition', async () => {
  const { repository, failedPartitions } = createRepository([
    { partitionKey: 'month:2026-06', status: 'available', lastAppliedSequence: 0 },
    { partitionKey: 'month:2026-05', status: 'available', lastAppliedSequence: 0 },
  ]);
  const attempted: string[] = [];
  const controlPlane = {
    updatePartitionCursor: async () => undefined,
    updateDeviceCursor: async () => undefined,
  } as unknown as SupabaseControlPlaneClient;
  const service = new ArchiveHydrationService(repository, {
    now: () => 30_000,
    backgroundArchiveBatchSize: 2,
    getArchiveHydrationPolicyInput: async () => ({
      isOnline: true,
      isWifi: true,
      isCharging: true,
    }),
    hydrateArchivePartition: async (input) => {
      attempted.push(input.partitionKey);
      throw new Error(`restore failed for ${input.partitionKey}`);
    },
  });

  const result = await service.hydrateBackgroundArchiveOnce({
    requireOnline: () => undefined,
    openRuntime: async () => createRuntime(controlPlane),
    assertActiveDevice: async () => undefined,
  });

  assert.deepEqual(result.hydratedPartitionKeys, []);
  assert.deepEqual(attempted, ['month:2026-06']);
  assert.deepEqual(failedPartitions, [
    {
      partitionKey: 'month:2026-06',
      error: 'restore failed for month:2026-06',
    },
  ]);
});
