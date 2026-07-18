import type { LocalDataStore } from '../../../platform/storage';
import type { SyncV2ApiClient } from '../api/SyncV2ApiClient';
import type {
  SyncV2MigrationStatus,
  SyncV2Pairing,
  SyncV2UploadInstruction,
} from '../api/SyncV2ApiTypes';
import { NOOP_SYNC_FAULT_INJECTOR, type SyncFaultInjector } from '../faults/SyncFaultInjector';
import { sha256Hex } from '../operation/BoundedObjectTransfer';

export interface WorkflowJournalStore<T> {
  load(): Promise<T | null>;
  save(value: T): Promise<void>;
  clear(): Promise<void>;
}

export class PersistentWorkflowJournalStore<T> implements WorkflowJournalStore<T> {
  constructor(
    private readonly storage: LocalDataStore,
    private readonly key: string,
  ) {}
  async load(): Promise<T | null> {
    const raw = await this.storage.getItem(this.key);
    return raw ? (JSON.parse(raw) as T) : null;
  }
  save(value: T): Promise<void> {
    return this.storage.setItem(this.key, JSON.stringify(value));
  }
  clear(): Promise<void> {
    return this.storage.removeItem(this.key);
  }
}

type MigrationApi = Pick<SyncV2ApiClient, 'beginMigration' | 'advanceMigration' | 'getMigration'>;
interface MigrationJournal {
  migrationId: string;
  deviceId: string;
  status: SyncV2MigrationStatus;
  baselineDigest: string;
  validationDigest?: string;
  snapshotId?: string;
}

export class SyncV2MigrationCoordinator {
  constructor(
    private readonly api: MigrationApi,
    private readonly journal: WorkflowJournalStore<MigrationJournal>,
    private readonly local: {
      drainV1(): Promise<void>;
      canonicalDigest(): Promise<string>;
      baselineSequence(): Promise<number>;
      createSnapshot(): Promise<{ snapshotId: string }>;
      verifyTemporaryRestore(snapshotId: string): Promise<string>;
      activateV2?(): Promise<void>;
    },
  ) {}

  async run(deviceId: string): Promise<void> {
    let state = await this.journal.load();
    if (!state) {
      const baselineDigest = await this.local.canonicalDigest();
      const baselineSequence = await this.local.baselineSequence();
      const migrationId = crypto.randomUUID();
      const remote = await this.api.beginMigration({
        migrationId,
        deviceId,
        baselineDigest,
        baselineSequence,
      });
      state = { migrationId, deviceId, baselineDigest, status: remote.status };
      await this.journal.save(state);
    }
    while (state.status !== 'V1_READ_ONLY') {
      if (state.status === 'FAILED' || state.status === 'ROLLED_BACK')
        throw new Error(`Migration stopped in ${state.status}.`);
      const next = await this.nextMigrationState(state);
      const remote = await this.api.advanceMigration(state.migrationId, {
        deviceId: state.deviceId,
        nextStatus: next,
        validationDigest: state.validationDigest,
        snapshotId: state.snapshotId,
      });
      state.status = remote.status;
      await this.journal.save(state);
    }
    await this.local.activateV2?.();
    await this.journal.clear();
  }

  private async nextMigrationState(state: MigrationJournal): Promise<SyncV2MigrationStatus> {
    switch (state.status) {
      case 'PRECHECK':
        return 'DRAINING_V1';
      case 'DRAINING_V1':
        await this.local.drainV1();
        return 'VALIDATING_LOCAL_STATE';
      case 'VALIDATING_LOCAL_STATE':
        state.validationDigest = await this.local.canonicalDigest();
        if (state.validationDigest !== state.baselineDigest)
          throw new Error('V1 changed while migration was draining.');
        return 'CREATING_V2_SNAPSHOT';
      case 'CREATING_V2_SNAPSHOT':
        state.snapshotId = (await this.local.createSnapshot()).snapshotId;
        return 'UPLOADING_V2_SNAPSHOT';
      case 'UPLOADING_V2_SNAPSHOT':
        return 'REGISTERING_V2_ACCOUNT';
      case 'REGISTERING_V2_ACCOUNT':
        return 'VERIFYING_V2_RESTORE';
      case 'VERIFYING_V2_RESTORE':
        if (
          !state.snapshotId ||
          (await this.local.verifyTemporaryRestore(state.snapshotId)) !== state.baselineDigest
        ) {
          throw new Error('V2 restore verification failed.');
        }
        return 'V2_ACTIVE';
      case 'V2_ACTIVE':
        return 'V1_READ_ONLY';
      default:
        throw new Error(`Unsupported migration state ${state.status}.`);
    }
  }
}

interface PairingJournal {
  pairingId: string;
  requestedDeviceId: string;
  privateKeyHandle: string;
  pairingCode: string;
  challenge: string;
}
interface PairingApprovalJournal {
  pairingId: string;
  keyPackageId: string;
  encryptedBase64: string;
  sha256: string;
}
type PairingApi = Pick<
  SyncV2ApiClient,
  'createPairing' | 'approvePairing' | 'registerPairingPackage' | 'getPairing' | 'completePairing'
>;

export class SyncV2PairingCoordinator {
  constructor(
    private readonly api: PairingApi,
    private readonly journal: WorkflowJournalStore<PairingJournal>,
    private readonly crypto: {
      createDeviceKey(): Promise<{
        signingPublicKey: string;
        encryptionPublicKey: string;
        privateKeyHandle: string;
      }>;
      randomChallenge(): Promise<string>;
      sign(privateKeyHandle: string, message: string): Promise<string>;
      approvalSignature(message: string): Promise<string>;
      encryptKeyPackage(requestedPublicKey: string): Promise<Uint8Array>;
      decryptAndPersist(
        privateKeyHandle: string,
        encrypted: Uint8Array,
        requestedPublicKey: string,
      ): Promise<void>;
    },
    private readonly transfer: {
      upload(bytes: Uint8Array, instruction: SyncV2UploadInstruction): Promise<void>;
      download(
        pairing: Pick<SyncV2Pairing, 'downloadUrl' | 'sha256' | 'sizeBytes'>,
      ): Promise<Uint8Array>;
    },
    private readonly approvalJournal: WorkflowJournalStore<PairingApprovalJournal>,
  ) {}

  async request(
    requestedDeviceId: string,
    platform: string,
  ): Promise<{ pairingId: string; pairingCode: string; requestedDeviceId: string }> {
    const existing = await this.journal.load();
    if (existing)
      return {
        pairingId: existing.pairingId,
        pairingCode: existing.pairingCode,
        requestedDeviceId: existing.requestedDeviceId,
      };
    const key = await this.crypto.createDeviceKey();
    const pairingId = crypto.randomUUID();
    const pairingCode = String(Math.floor(Math.random() * 100_000_000)).padStart(8, '0');
    const challenge = await this.crypto.randomChallenge();
    const codeHash = await sha256Hex(new TextEncoder().encode(pairingCode));
    await this.journal.save({
      pairingId,
      requestedDeviceId,
      privateKeyHandle: key.privateKeyHandle,
      pairingCode,
      challenge,
    });
    await this.api.createPairing({
      pairingId,
      requestedDeviceId,
      requestedDeviceSigningPublicKey: key.signingPublicKey,
      requestedDeviceEncryptionPublicKey: key.encryptionPublicKey,
      platform,
      codeHash,
      challenge,
    });
    return { pairingId, pairingCode, requestedDeviceId };
  }

  async approve(input: {
    pairingId: string;
    requestedDeviceId: string;
    requestedPublicKey: string;
    challenge: string;
    pairingCode: string;
    approverDeviceId: string;
    keyEpoch: number;
  }): Promise<void> {
    const codeHash = await sha256Hex(new TextEncoder().encode(input.pairingCode));
    const approvalMessage = `${input.pairingId}:${input.requestedDeviceId}:${input.challenge}:${codeHash}`;
    let journal = await this.approvalJournal.load();
    if (journal && journal.pairingId !== input.pairingId)
      throw new Error('Another pairing approval is in progress.');
    if (!journal) {
      const bytes = await this.crypto.encryptKeyPackage(input.requestedPublicKey);
      journal = {
        pairingId: input.pairingId,
        keyPackageId: crypto.randomUUID(),
        encryptedBase64: toBase64(bytes),
        sha256: await sha256Hex(bytes),
      };
      await this.approvalJournal.save(journal);
    }
    const bytes = fromBase64(journal.encryptedBase64);
    const approved = await this.api.approvePairing(input.pairingId, {
      approverDeviceId: input.approverDeviceId,
      pairingCode: input.pairingCode,
      approvalSignature: await this.crypto.approvalSignature(approvalMessage),
      keyPackageId: journal.keyPackageId,
      sha256: journal.sha256,
      sizeBytes: bytes.byteLength,
      packageSchemaVersion: 1,
    });
    if (!approved.upload) throw new Error('Pairing package upload was not issued.');
    await this.transfer.upload(bytes, approved.upload);
    await this.api.registerPairingPackage(input.pairingId, input.approverDeviceId);
    await this.approvalJournal.clear();
  }

  async complete(afterComplete?: (pairing: SyncV2Pairing) => Promise<void>): Promise<void> {
    const state = await this.journal.load();
    if (!state) throw new Error('No pairing is in progress.');
    const remote = await this.api.getPairing(state.pairingId, state.requestedDeviceId);
    if (!remote.downloadUrl || !remote.keyPackageId)
      throw new Error('Pairing package is not available.');
    await this.crypto.decryptAndPersist(
      state.privateKeyHandle,
      await this.transfer.download(remote),
      remote.requestedDeviceEncryptionPublicKey,
    );
    const message = `pairing-complete:${state.pairingId}:${remote.keyPackageId}`;
    const completed = await this.api.completePairing(state.pairingId, {
      requestedDeviceId: state.requestedDeviceId,
      possessionSignature: await this.crypto.sign(state.privateKeyHandle, message),
    });
    await afterComplete?.(completed);
    await this.journal.clear();
  }
}

interface RecoveryJournal {
  attemptId: string;
  deviceId: string;
  privateKeyHandle: string;
  keyPersisted: boolean;
}
type RecoveryApi = Pick<
  SyncV2ApiClient,
  | 'beginRecovery'
  | 'approveRecovery'
  | 'getRecoveryPackage'
  | 'markRecoveryKeyPersisted'
  | 'finalizeRecovery'
  | 'acknowledgeCursor'
>;

export class SyncV2RecoveryCoordinator {
  constructor(
    private readonly api: RecoveryApi,
    private readonly journal: WorkflowJournalStore<RecoveryJournal>,
    private readonly local: {
      createDeviceKey(): Promise<{ publicKey: string; privateKeyHandle: string }>;
      download(url: string): Promise<Uint8Array>;
      unwrapAndPersist(privateKeyHandle: string, bytes: Uint8Array): Promise<void>;
      restoreValidationSnapshot(): Promise<{ snapshotId: string; throughSequence: number }>;
      sign(privateKeyHandle: string, message: string): Promise<string>;
    },
    private readonly faults: SyncFaultInjector = NOOP_SYNC_FAULT_INJECTOR,
  ) {}

  async run(deviceId: string, platform: string): Promise<void> {
    let state = await this.journal.load();
    if (!state) {
      const key = await this.local.createDeviceKey();
      state = {
        attemptId: crypto.randomUUID(),
        deviceId,
        privateKeyHandle: key.privateKeyHandle,
        keyPersisted: false,
      };
      await this.journal.save(state);
      await this.api.beginRecovery({
        recoveryAttemptId: state.attemptId,
        recoveryDeviceId: deviceId,
        recoveryDevicePublicKey: key.publicKey,
        platform,
      });
    }
    await this.api.approveRecovery(state.attemptId, state.deviceId);
    if (!state.keyPersisted) {
      const recovery = await this.api.getRecoveryPackage(state.attemptId, state.deviceId);
      const url = recovery.recoveryPackage?.downloadUrl;
      if (!url) throw new Error('Recovery package is not available.');
      await this.faults.hit('BEFORE_LOCAL_KEY_PERSIST');
      await this.local.unwrapAndPersist(state.privateKeyHandle, await this.local.download(url));
      state.keyPersisted = true;
      await this.journal.save(state);
    }
    const restored = await this.local.restoreValidationSnapshot();
    const proof = await this.local.sign(
      state.privateKeyHandle,
      `recovery-key-persisted:${state.attemptId}:${restored.snapshotId}`,
    );
    await this.api.markRecoveryKeyPersisted(state.attemptId, {
      recoveryDeviceId: state.deviceId,
      validationSnapshotId: restored.snapshotId,
      possessionSignature: proof,
    });
    await this.api.acknowledgeCursor(state.deviceId, restored.throughSequence);
    await this.faults.hit('DURING_RECOVERY_FINALIZATION');
    await this.api.finalizeRecovery(state.attemptId, state.deviceId);
    await this.journal.clear();
  }
}

interface RotationPackageJournal {
  keyPackageId: string;
  targetDeviceId: string;
  purpose: 'DEVICE' | 'RECOVERY';
  encryptedBase64: string;
  sha256: string;
  registered: boolean;
}
interface RotationJournal {
  rotationId: string;
  deviceId: string;
  toEpoch: number;
  encryptedKeyHandle: string;
  packages?: RotationPackageJournal[];
  packagesUploaded: boolean;
  revokedDeviceId?: string;
}
type RotationApi = Pick<
  SyncV2ApiClient,
  | 'beginRotation'
  | 'advanceRotation'
  | 'initiateKeyPackage'
  | 'registerKeyPackage'
  | 'commitRotationEpoch'
  | 'markRotationLocalCommitted'
  | 'getRotation'
>;

export class SyncV2RotationCoordinator {
  constructor(
    private readonly api: RotationApi,
    private readonly journal: WorkflowJournalStore<RotationJournal>,
    private readonly local: {
      createEncryptedAccountKey(toEpoch: number): Promise<string>;
      packageForTarget(
        encryptedKeyHandle: string,
        targetDeviceId: string,
        purpose: 'DEVICE' | 'RECOVERY',
      ): Promise<Uint8Array>;
      upload(bytes: Uint8Array, instruction: SyncV2UploadInstruction): Promise<void>;
      activeDeviceIds(): Promise<string[]>;
      recoveryTargetDeviceId(): Promise<string>;
      commitEncryptedAccountKey(encryptedKeyHandle: string, toEpoch: number): Promise<void>;
      sign(message: string): Promise<string>;
    },
    private readonly faults: SyncFaultInjector = NOOP_SYNC_FAULT_INJECTOR,
  ) {}

  async run(deviceId: string, revokedDeviceId?: string): Promise<void> {
    let state = await this.journal.load();
    let remote;
    if (!state) {
      const rotationId = crypto.randomUUID();
      remote = await this.api.beginRotation(rotationId, deviceId, revokedDeviceId);
      const encryptedKeyHandle = await this.local.createEncryptedAccountKey(remote.toKeyEpoch);
      state = {
        rotationId,
        deviceId,
        toEpoch: remote.toKeyEpoch,
        encryptedKeyHandle,
        packagesUploaded: false,
        revokedDeviceId,
      };
      await this.journal.save(state);
      await this.faults.hit('AFTER_KEY_CREATION');
    } else {
      remote = await this.api.getRotation(state.rotationId);
      if (
        (state.revokedDeviceId || undefined) !==
        (revokedDeviceId || state.revokedDeviceId || undefined)
      ) {
        throw new Error('A different companion revocation is already in progress.');
      }
    }
    if (remote.status === 'PREPARING')
      remote = await this.api.advanceRotation(state.rotationId, deviceId, 'NEW_KEY_CREATED');
    if (!state.packagesUploaded) {
      if (!state.packages) {
        const targets: Array<{ targetDeviceId: string; purpose: 'DEVICE' | 'RECOVERY' }> = (
          await this.local.activeDeviceIds()
        ).map((targetDeviceId) => ({ targetDeviceId, purpose: 'DEVICE' }));
        targets.push({
          targetDeviceId: await this.local.recoveryTargetDeviceId(),
          purpose: 'RECOVERY',
        });
        state.packages = [];
        for (const target of targets) {
          const bytes = await this.local.packageForTarget(
            state.encryptedKeyHandle,
            target.targetDeviceId,
            target.purpose,
          );
          state.packages.push({
            ...target,
            keyPackageId: crypto.randomUUID(),
            encryptedBase64: toBase64(bytes),
            sha256: await sha256Hex(bytes),
            registered: false,
          });
        }
        await this.journal.save(state);
      }
      for (const keyPackage of state.packages) {
        if (keyPackage.registered) continue;
        await this.uploadPackage(state, keyPackage);
        keyPackage.registered = true;
        await this.journal.save(state);
      }
      state.packagesUploaded = true;
      await this.journal.save(state);
      await this.faults.hit('AFTER_KEY_PACKAGE_UPLOAD');
    }
    remote = await this.api.getRotation(state.rotationId);
    if (remote.status === 'NEW_KEY_CREATED')
      remote = await this.api.advanceRotation(
        state.rotationId,
        state.deviceId,
        'KEY_PACKAGES_CREATED',
      );
    if (remote.status === 'KEY_PACKAGES_CREATED')
      remote = await this.api.advanceRotation(
        state.rotationId,
        state.deviceId,
        'SERVER_EPOCH_PENDING',
      );
    if (remote.status === 'SERVER_EPOCH_PENDING') {
      remote = await this.api.commitRotationEpoch(state.rotationId, state.deviceId);
      await this.faults.hit('AFTER_SERVER_EPOCH_COMMIT');
    }
    if (remote.status === 'SERVER_EPOCH_COMMITTED') {
      await this.faults.hit('BEFORE_LOCAL_KEY_PERSIST');
      await this.local.commitEncryptedAccountKey(state.encryptedKeyHandle, state.toEpoch);
      const proof = await this.local.sign(
        `rotation-local-committed:${state.rotationId}:${state.toEpoch}`,
      );
      remote = await this.api.markRotationLocalCommitted(state.rotationId, state.deviceId, proof);
    }
    if (remote.status === 'LOCAL_STATE_COMMITTED') {
      await this.api.advanceRotation(state.rotationId, state.deviceId, 'COMPLETED');
    }
    await this.journal.clear();
  }

  private async uploadPackage(
    state: RotationJournal,
    keyPackage: RotationPackageJournal,
  ): Promise<void> {
    const bytes = fromBase64(keyPackage.encryptedBase64);
    const initiated = await this.api.initiateKeyPackage({
      keyPackageId: keyPackage.keyPackageId,
      creatorDeviceId: state.deviceId,
      targetDeviceId: keyPackage.targetDeviceId,
      keyEpoch: state.toEpoch,
      purpose: keyPackage.purpose,
      sha256: keyPackage.sha256,
      sizeBytes: bytes.byteLength,
      packageSchemaVersion: 1,
      rotationId: state.rotationId,
    });
    if (!initiated.upload) throw new Error('Key package upload was not issued.');
    await this.local.upload(bytes, initiated.upload);
    await this.api.registerKeyPackage(keyPackage.keyPackageId, state.deviceId);
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return typeof btoa === 'function' ? btoa(binary) : Buffer.from(bytes).toString('base64');
}

function fromBase64(value: string): Uint8Array {
  if (typeof atob === 'function')
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  return new Uint8Array(Buffer.from(value, 'base64'));
}
