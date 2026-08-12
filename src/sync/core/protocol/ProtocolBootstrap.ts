import type { LocalDataStore } from '../../../platform/storage';
import type { SyncHealthStore } from '../../health/SyncHealthService';
import type { OutboxRepository } from '../../outbox';
import { SyncError } from '../../errors';
import type { SyncApiClient } from '../api/SyncApiClient';
import type { SyncProtocol } from '../api/SyncApiTypes';
import type { PersistentSafetyStopStore } from '../safety/PersistentSafetyStopStore';
import { isVersionAtLeast, type RuntimeControlStore } from './RuntimeControlStore';

const RUNTIME_KEY = 'deardiary_sync_account';

export interface SyncLocalRuntime {
  accountId: string;
  deviceId: string;
  deviceStatus: 'ACTIVE' | 'RECOVERY_PENDING' | 'REVOKED';
  protocolVersion: number;
  eventSchemaVersion: number;
  keyEpoch: number;
  appliedSequence: number;
  lastCommittedSequence?: number;
  lastRestoredSnapshotId?: string;
  updatedAt: number;
}

export interface ProtocolBootstrapResult {
  runtime: SyncLocalRuntime;
  protocol: SyncProtocol;
  pullAllowed: boolean;
  writesAllowed: boolean;
  upgradeRequired: boolean;
}

export class SyncRuntimeStore {
  constructor(private readonly store: LocalDataStore) {}

  async load(): Promise<SyncLocalRuntime | null> {
    const raw = await this.store.getItem(RUNTIME_KEY);
    return raw ? (JSON.parse(raw) as SyncLocalRuntime) : null;
  }

  async save(runtime: SyncLocalRuntime): Promise<void> {
    const existing = await this.store.getItem(RUNTIME_KEY);
    const identity = existing ? (JSON.parse(existing) as Record<string, unknown>) : {};
    await this.store.setItem(RUNTIME_KEY, JSON.stringify({ ...identity, ...runtime }));
  }

  clear(): Promise<void> {
    return this.store.removeItem(RUNTIME_KEY);
  }
}

export class ProtocolBootstrap {
  constructor(
    private readonly runtimeStore: SyncRuntimeStore,
    private readonly api: Pick<SyncApiClient, 'getProtocol'>,
    private readonly outbox: OutboxRepository,
    private readonly health: SyncHealthStore,
    private readonly safetyStop: PersistentSafetyStopStore,
    private readonly clientProtocolVersion: number,
    private readonly now: () => number = Date.now,
    private readonly appVersion = '0.0.0',
    private readonly controls?: RuntimeControlStore,
  ) {}

  async initialize(): Promise<ProtocolBootstrapResult> {
    const runtime = await this.runtimeStore.load();
    if (!runtime) throw new SyncError({ code: 'AUTH_INVALID', userActionRequired: true });
    let protocol: SyncProtocol;
    try {
      protocol = await this.api.getProtocol();
      await this.controls?.save(protocol);
    } catch (error) {
      if (!this.controls) throw error;
      protocol = this.controls.asProtocol(await this.controls.loadSafeFallback());
    }
    const readCompatible = this.clientProtocolVersion >= protocol.minimumReadProtocolVersion;
    const writeCompatible = this.clientProtocolVersion >= protocol.minimumWriteProtocolVersion;
    if (runtime.deviceStatus !== 'ACTIVE')
      throw new SyncError({ code: 'DEVICE_REVOKED', userActionRequired: true });
    await this.outbox.releaseExpiredLeases(runtime.accountId, this.now());
    const stopped = await this.safetyStop.get(runtime.accountId);
    const schemaCompatible = runtime.eventSchemaVersion === protocol.eventSchemaVersion;
    const appCompatible = isVersionAtLeast(this.appVersion, protocol.minimumSupportedAppVersion);
    const upgradeRequired =
      !readCompatible || !writeCompatible || !schemaCompatible || !appCompatible;
    const pullAllowed =
      protocol.featureFlags.remotePullEnabled &&
      readCompatible &&
      schemaCompatible &&
      !stopped;
    const writesAllowed =
      protocol.featureFlags.syncWritesEnabled && !upgradeRequired && !stopped;
    await this.health.updateSyncHealth({
      accountId: runtime.accountId,
      localSequence: runtime.appliedSequence,
      remoteSequence: undefined,
      authState: 'VALID',
      integrityState: stopped ? 'SAFETY_STOP' : upgradeRequired ? 'WARNING' : 'HEALTHY',
      lastErrorCode: upgradeRequired ? 'PROTOCOL_INCOMPATIBLE' : stopped?.errorCode,
      lastErrorAt: upgradeRequired || stopped ? this.now() : undefined,
    });
    return { runtime, protocol, pullAllowed, writesAllowed, upgradeRequired };
  }
}
