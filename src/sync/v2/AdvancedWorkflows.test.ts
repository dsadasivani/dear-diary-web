import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SyncV2MigrationCoordinator,
  SyncV2RecoveryCoordinator,
  SyncV2RotationCoordinator,
  type WorkflowJournalStore,
} from './advanced/AdvancedWorkflowCoordinators';
import { InjectedSyncCrash, TestSyncFaultInjector } from './faults/SyncFaultInjector';
import type { SyncV2MigrationStatus, SyncV2Rotation } from './api/SyncV2ApiTypes';

class MemoryJournal<T> implements WorkflowJournalStore<T> {
  value: T | null = null;
  async load() { return this.value; }
  async save(value: T) { this.value = structuredClone(value); }
  async clear() { this.value = null; }
}

test('migration resumes after V1 drain crash and only then makes V1 read-only', async () => {
  const journal = new MemoryJournal<any>();
  let status: SyncV2MigrationStatus = 'PRECHECK';
  const seen: string[] = [];
  const api = {
    async beginMigration() { return response(); },
    async advanceMigration(_id: string, request: { nextStatus: SyncV2MigrationStatus }) {
      status = request.nextStatus;
      seen.push(status);
      return response();
    },
    async getMigration() { return response(); },
  } as any;
  let drainAttempts = 0;
  const coordinator = new SyncV2MigrationCoordinator(api, journal, {
    async drainV1() { if (drainAttempts++ === 0) throw new Error('crash'); },
    async canonicalDigest() { return 'a'.repeat(64); },
    async baselineSequence() { return 0; },
    async createSnapshot() { return { snapshotId: 'snapshot-1' }; },
    async verifyTemporaryRestore() { return 'a'.repeat(64); },
  });
  await assert.rejects(() => coordinator.run('device-1'));
  assert.equal(journal.value.status, 'DRAINING_V1');
  await coordinator.run('device-1');
  assert.equal(journal.value, null);
  assert.equal(seen.at(-1), 'V1_READ_ONLY');
  function response() {
    return { migrationId: 'migration-1', status, baselineDigest: 'a'.repeat(64), validationDigest: null,
      baselineSequence: 0, activatedSequence: null, snapshotId: null, v1Mode: status === 'V1_READ_ONLY' ? 'READ_ONLY' : 'READ_WRITE' };
  }
});

test('recovery never persists the key before the crash-safe fault boundary', async () => {
  const journal = new MemoryJournal<any>();
  let persistCount = 0;
  let finalizeCount = 0;
  const api = {
    async beginRecovery() { return {}; }, async approveRecovery() { return {}; },
    async getRecoveryPackage() { return { recoveryPackage: { downloadUrl: 'memory://package' } }; },
    async markRecoveryKeyPersisted() { return {}; }, async acknowledgeCursor() {},
    async finalizeRecovery() { finalizeCount += 1; return {}; },
  } as any;
  const local = {
    async createDeviceKey() { return { publicKey: 'public', privateKeyHandle: 'secure-handle' }; },
    async download() { return new Uint8Array([1]); },
    async unwrapAndPersist() { persistCount += 1; },
    async restoreValidationSnapshot() { return { snapshotId: 'snapshot-1', throughSequence: 7 }; },
    async sign() { return 'signature'; },
  };
  const crashing = new SyncV2RecoveryCoordinator(api, journal, local,
    new TestSyncFaultInjector({ BEFORE_LOCAL_KEY_PERSIST: 1 }));
  await assert.rejects(() => crashing.run('device-1', 'test'), InjectedSyncCrash);
  assert.equal(persistCount, 0);
  await new SyncV2RecoveryCoordinator(api, journal, local).run('device-1', 'test');
  assert.equal(persistCount, 1);
  assert.equal(finalizeCount, 1);
  assert.equal(journal.value, null);
});

test('rotation resumes after authoritative epoch commit without committing it twice', async () => {
  const journal = new MemoryJournal<any>();
  let status: SyncV2Rotation['status'] = 'PREPARING';
  let epochCommits = 0;
  let localCommits = 0;
  const rotation = (): SyncV2Rotation => ({ rotationId: 'rotation-1', initiatedByDeviceId: 'device-1',
    fromKeyEpoch: 1, toKeyEpoch: 2, status });
  const api = {
    async beginRotation() { return rotation(); }, async getRotation() { return rotation(); },
    async advanceRotation(_id: string, _device: string, next: SyncV2Rotation['status']) { status = next; return rotation(); },
    async initiateKeyPackage(request: { keyPackageId: string }) { return { keyPackageId: request.keyPackageId, upload: { objectKey: 'k', uploadUrl: 'memory://upload', headers: {}, expiresAt: '' } }; },
    async registerKeyPackage() { return {}; },
    async commitRotationEpoch() { epochCommits += 1; status = 'SERVER_EPOCH_COMMITTED'; return rotation(); },
    async markRotationLocalCommitted() { status = 'LOCAL_STATE_COMMITTED'; return rotation(); },
  } as any;
  const local = {
    async createEncryptedAccountKey() { return 'encrypted-secure-handle'; },
    async packageForTarget() { return new Uint8Array([1, 2]); }, async upload() {},
    async activeDeviceIds() { return ['device-1']; }, async recoveryTargetDeviceId() { return 'device-1'; },
    async commitEncryptedAccountKey() { localCommits += 1; }, async sign() { return 'signature'; },
  };
  const crashing = new SyncV2RotationCoordinator(api, journal, local,
    new TestSyncFaultInjector({ AFTER_SERVER_EPOCH_COMMIT: 1 }));
  await assert.rejects(() => crashing.run('device-1'), InjectedSyncCrash);
  assert.equal(epochCommits, 1);
  await new SyncV2RotationCoordinator(api, journal, local).run('device-1');
  assert.equal(epochCommits, 1);
  assert.equal(localCommits, 1);
  assert.equal(status, 'COMPLETED');
  assert.equal(journal.value, null);
});
