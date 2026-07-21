import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SyncV2MigrationCoordinator,
  SyncV2PairingCoordinator,
  SyncV2RecoveryCoordinator,
  SyncV2RotationCoordinator,
  type WorkflowJournalStore,
} from './advanced/AdvancedWorkflowCoordinators';
import { InjectedSyncCrash, TestSyncFaultInjector } from './faults/SyncFaultInjector';
import type { SyncV2MigrationStatus, SyncV2Pairing, SyncV2Rotation } from './api/SyncV2ApiTypes';

class MemoryJournal<T> implements WorkflowJournalStore<T> {
  value: T | null = null;
  async load() {
    return this.value;
  }
  async save(value: T) {
    this.value = structuredClone(value);
  }
  async clear() {
    this.value = null;
  }
}

const pairingResponse = (patch: Partial<SyncV2Pairing> = {}): SyncV2Pairing => ({
  accountId: 'account-1',
  pairingId: 'pairing-1',
  requestedDeviceId: 'device-2',
  requestedDeviceEncryptionPublicKey: 'encryption-public',
  platform: 'web',
  challenge: 'challenge',
  status: 'REQUESTED',
  keyEpoch: 1,
  keyPackageId: null,
  objectKey: null,
  sha256: null,
  sizeBytes: null,
  downloadUrl: null,
  downloadExpiresAt: null,
  upload: null,
  requestedAt: new Date(0).toISOString(),
  expiresAt: new Date(60_000).toISOString(),
  ...patch,
});

test('pairing request sends distinct signing and encryption public keys', async () => {
  const journal = new MemoryJournal<any>();
  let created: Record<string, unknown> | null = null;
  const coordinator = new SyncV2PairingCoordinator(
    {
      async createPairing(request: Record<string, unknown>) {
        created = request;
        return pairingResponse();
      },
    } as any,
    journal,
    {
      async createDeviceKey() {
        return {
          signingPublicKey: 'signing-public',
          encryptionPublicKey: 'encryption-public',
          privateKeyHandle: 'private',
        };
      },
      async randomChallenge() {
        return 'challenge';
      },
      async sign() {
        return 'signature';
      },
      async approvalSignature() {
        return 'signature';
      },
      async encryptKeyPackage() {
        return new Uint8Array([1]);
      },
      async decryptAndPersist() {},
    },
    {
      async upload() {},
      async download() {
        return new Uint8Array([1]);
      },
    },
    new MemoryJournal<any>(),
  );
  const request = await coordinator.request('device-2', 'web');
  assert.equal(request.requestedDeviceId, 'device-2');
  assert.equal(created?.requestedDeviceSigningPublicKey, 'signing-public');
  assert.equal(created?.requestedDeviceEncryptionPublicKey, 'encryption-public');
});

test('pairing completion retains its secure journal until local snapshot activation succeeds', async () => {
  const journal = new MemoryJournal<any>();
  journal.value = {
    pairingId: 'pairing-1',
    requestedDeviceId: 'device-2',
    privateKeyHandle: 'private',
    pairingCode: '12345678',
    challenge: 'challenge',
  };
  let completionCalls = 0;
  const coordinator = new SyncV2PairingCoordinator(
    {
      async getPairing() {
        return pairingResponse({
          status: 'KEY_PACKAGE_AVAILABLE',
          keyPackageId: 'package-1',
          downloadUrl: 'memory://package',
          sha256: 'a'.repeat(64),
          sizeBytes: 1,
        });
      },
      async completePairing() {
        completionCalls += 1;
        return pairingResponse({ status: 'COMPLETED', keyPackageId: 'package-1' });
      },
    } as any,
    journal,
    {
      async createDeviceKey() {
        throw new Error('unused');
      },
      async randomChallenge() {
        return 'unused';
      },
      async sign() {
        return 'signature';
      },
      async approvalSignature() {
        return 'signature';
      },
      async encryptKeyPackage() {
        return new Uint8Array([1]);
      },
      async decryptAndPersist() {},
    },
    {
      async upload() {},
      async download() {
        return new Uint8Array([1]);
      },
    },
    new MemoryJournal<any>(),
  );
  await assert.rejects(() =>
    coordinator.complete(async () => {
      throw new Error('snapshot import interrupted');
    }),
  );
  assert.notEqual(journal.value, null);
  await coordinator.complete(async () => undefined);
  assert.equal(completionCalls, 2);
  assert.equal(journal.value, null);
});

test('migration resumes after V1 drain crash and only then makes V1 read-only', async () => {
  const journal = new MemoryJournal<any>();
  let status: SyncV2MigrationStatus = 'PRECHECK';
  const seen: string[] = [];
  const api = {
    async beginMigration() {
      return response();
    },
    async advanceMigration(_id: string, request: { nextStatus: SyncV2MigrationStatus }) {
      status = request.nextStatus;
      seen.push(status);
      return response();
    },
    async getMigration() {
      return response();
    },
  } as any;
  let drainAttempts = 0;
  const coordinator = new SyncV2MigrationCoordinator(api, journal, {
    async drainV1() {
      if (drainAttempts++ === 0) throw new Error('crash');
    },
    async canonicalDigest() {
      return 'a'.repeat(64);
    },
    async baselineSequence() {
      return 0;
    },
    async createSnapshot() {
      return { snapshotId: 'snapshot-1' };
    },
    async verifyTemporaryRestore() {
      return 'a'.repeat(64);
    },
  });
  await assert.rejects(() => coordinator.run('device-1'));
  assert.equal(journal.value.status, 'DRAINING_V1');
  await coordinator.run('device-1');
  assert.equal(journal.value, null);
  assert.equal(seen.at(-1), 'V1_READ_ONLY');
  function response() {
    return {
      migrationId: 'migration-1',
      status,
      baselineDigest: 'a'.repeat(64),
      validationDigest: null,
      baselineSequence: 0,
      activatedSequence: null,
      snapshotId: null,
      v1Mode: status === 'V1_READ_ONLY' ? 'READ_ONLY' : 'READ_WRITE',
    };
  }
});

test('migration keeps its journal until local V2 activation succeeds', async () => {
  const journal = new MemoryJournal<any>();
  let status: SyncV2MigrationStatus = 'PRECHECK';
  let activationAttempts = 0;
  const response = () => ({
    migrationId: 'migration-activation',
    status,
    baselineDigest: 'b'.repeat(64),
    validationDigest: null,
    baselineSequence: 4,
    activatedSequence: status === 'V1_READ_ONLY' ? 0 : null,
    snapshotId: 'snapshot-activation',
    v1Mode: status === 'V1_READ_ONLY' ? 'READ_ONLY' : 'READ_WRITE',
  });
  const api = {
    async beginMigration() {
      return response();
    },
    async advanceMigration(_id: string, request: { nextStatus: SyncV2MigrationStatus }) {
      status = request.nextStatus;
      return response();
    },
    async getMigration() {
      return response();
    },
  } as any;
  const local = {
    async drainV1() {},
    async canonicalDigest() {
      return 'b'.repeat(64);
    },
    async baselineSequence() {
      return 4;
    },
    async createSnapshot() {
      return { snapshotId: 'snapshot-activation' };
    },
    async verifyTemporaryRestore() {
      return 'b'.repeat(64);
    },
    async activateV2() {
      if (activationAttempts++ === 0) throw new Error('local persistence interrupted');
    },
  };
  const coordinator = new SyncV2MigrationCoordinator(api, journal, local);
  await assert.rejects(() => coordinator.run('device-1'), /local persistence interrupted/);
  assert.equal(journal.value.status, 'V1_READ_ONLY');
  await coordinator.run('device-1');
  assert.equal(activationAttempts, 2);
  assert.equal(journal.value, null);
});

test('recovery never persists the key before the crash-safe fault boundary', async () => {
  const journal = new MemoryJournal<any>();
  let persistCount = 0;
  let finalizeCount = 0;
  const api = {
    async beginRecovery() {
      return {};
    },
    async approveRecovery() {
      return {};
    },
    async getRecoveryPackage() {
      return { recoveryPackage: { downloadUrl: 'memory://package' } };
    },
    async markRecoveryKeyPersisted() {
      return {};
    },
    async acknowledgeCursor() {},
    async finalizeRecovery() {
      finalizeCount += 1;
      return {};
    },
  } as any;
  const local = {
    async createDeviceKey() {
      return {
        publicKey: 'public',
        signingPublicKey: 'signing-public',
        encryptionPublicKey: 'encryption-public',
        privateKeyHandle: 'secure-handle',
      };
    },
    async download() {
      return new Uint8Array([1]);
    },
    async unwrapAndPersist() {
      persistCount += 1;
    },
    async restoreValidationSnapshot() {
      return { snapshotId: 'snapshot-1', throughSequence: 7 };
    },
    async sign() {
      return 'signature';
    },
  };
  const crashing = new SyncV2RecoveryCoordinator(
    api,
    journal,
    local,
    new TestSyncFaultInjector({ BEFORE_LOCAL_KEY_PERSIST: 1 }),
  );
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
  let revokedDeviceId: string | null = null;
  const rotation = (): SyncV2Rotation => ({
    rotationId: 'rotation-1',
    initiatedByDeviceId: 'device-1',
    revokedDeviceId,
    fromKeyEpoch: 1,
    toKeyEpoch: 2,
    status,
  });
  const api = {
    async beginRotation(_id: string, _device: string, revoked?: string) {
      revokedDeviceId = revoked || null;
      return rotation();
    },
    async getRotation() {
      return rotation();
    },
    async advanceRotation(_id: string, _device: string, next: SyncV2Rotation['status']) {
      status = next;
      return rotation();
    },
    async initiateKeyPackage(request: { keyPackageId: string }) {
      return {
        keyPackageId: request.keyPackageId,
        upload: { objectKey: 'k', uploadUrl: 'memory://upload', headers: {}, expiresAt: '' },
      };
    },
    async registerKeyPackage() {
      return {};
    },
    async commitRotationEpoch() {
      epochCommits += 1;
      status = 'SERVER_EPOCH_COMMITTED';
      return rotation();
    },
    async markRotationLocalCommitted() {
      status = 'LOCAL_STATE_COMMITTED';
      return rotation();
    },
  } as any;
  const local = {
    async createEncryptedAccountKey() {
      return 'encrypted-secure-handle';
    },
    async packageForTarget() {
      return new Uint8Array([1, 2]);
    },
    async upload() {},
    async activeDeviceIds() {
      return ['device-1'];
    },
    async recoveryTargetDeviceId() {
      return 'device-1';
    },
    async commitEncryptedAccountKey() {
      localCommits += 1;
    },
    async sign() {
      return 'signature';
    },
  };
  const crashing = new SyncV2RotationCoordinator(
    api,
    journal,
    local,
    new TestSyncFaultInjector({ AFTER_SERVER_EPOCH_COMMIT: 1 }),
  );
  await assert.rejects(() => crashing.run('device-1', 'companion-1'), InjectedSyncCrash);
  assert.equal(epochCommits, 1);
  assert.equal(revokedDeviceId, 'companion-1');
  await new SyncV2RotationCoordinator(api, journal, local).run('device-1', 'companion-1');
  assert.equal(epochCommits, 1);
  assert.equal(localCommits, 1);
  assert.equal(status, 'COMPLETED');
  assert.equal(journal.value, null);
});
