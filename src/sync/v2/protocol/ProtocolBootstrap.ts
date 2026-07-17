import type { LocalDataStore } from '../../../platform/storage';
import type { SyncHealthStore } from '../../health/SyncHealthService';
import type { OutboxRepository } from '../../outbox';
import { SyncError } from '../../errors';
import type { SyncV2ApiClient } from '../api/SyncV2ApiClient';
import type { SyncV2Protocol } from '../api/SyncV2ApiTypes';
import type { PersistentSafetyStopStore } from '../safety/PersistentSafetyStopStore';
import { isCanaryEnabled, isVersionAtLeast, type RuntimeControlStore } from './RuntimeControlStore';

const RUNTIME_KEY = 'deardiary_sync_v2_runtime';

export interface SyncV2LocalRuntime {
  accountId: string;
  deviceId: string;
  deviceStatus: 'ACTIVE' | 'RECOVERY_PENDING' | 'REVOKED';
  protocolVersion: number;
  eventSchemaVersion: number;
  keyEpoch: number;
  lastAppliedSequence: number;
  lastCommittedSequence?: number;
  updatedAt: number;
}

export interface ProtocolBootstrapResult {
  runtime: SyncV2LocalRuntime;
  protocol: SyncV2Protocol;
  pullAllowed: boolean;
  writesAllowed: boolean;
  upgradeRequired: boolean;
}

export class SyncV2RuntimeStore {
  constructor(private readonly store: LocalDataStore) {}

  async load(): Promise<SyncV2LocalRuntime | null> {
    const raw = await this.store.getItem(RUNTIME_KEY);
    return raw ? JSON.parse(raw) as SyncV2LocalRuntime : null;
  }

  save(runtime: SyncV2LocalRuntime): Promise<void> {
    return this.store.setItem(RUNTIME_KEY, JSON.stringify(runtime));
  }

  clear(): Promise<void> {
    return this.store.removeItem(RUNTIME_KEY);
  }
}

export class ProtocolBootstrap {
  constructor(
    private readonly runtimeStore: SyncV2RuntimeStore,
    private readonly api: Pick<SyncV2ApiClient, 'getProtocol'>,
    private readonly outbox: OutboxRepository,
    private readonly health: SyncHealthStore,
    private readonly safetyStop: PersistentSafetyStopStore,
    private readonly clientProtocolVersion: number,
    private readonly now: () => number = Date.now,
    private readonly appVersion = '0.0.0',
    private readonly rolloutPseudonym = 'local-default',
    private readonly controls?: RuntimeControlStore,
  ) {}

  async initialize(): Promise<ProtocolBootstrapResult> {
    const runtime = await this.runtimeStore.load();
    if (!runtime) throw new SyncError({ code: 'AUTH_INVALID', userActionRequired: true });
    let protocol: SyncV2Protocol;
    try {
      protocol = await this.api.getProtocol();
      await this.controls?.save(protocol);
    } catch (error) {
      if (!this.controls) throw error;
      protocol = this.controls.asProtocol(await this.controls.loadSafeFallback());
    }
    const readCompatible = this.clientProtocolVersion >= protocol.minimumReadProtocolVersion;
    const writeCompatible = this.clientProtocolVersion >= protocol.minimumWriteProtocolVersion;
    if (runtime.deviceStatus !== 'ACTIVE') throw new SyncError({ code: 'DEVICE_REVOKED', userActionRequired: true });
    await this.outbox.releaseExpiredLeases(runtime.accountId, this.now());
    const stopped = await this.safetyStop.get(runtime.accountId);
    const schemaCompatible = runtime.eventSchemaVersion === protocol.eventSchemaVersion;
    const appCompatible = isVersionAtLeast(this.appVersion, protocol.minimumSupportedAppVersion);
    const rolloutEligible = await isCanaryEnabled(
      this.rolloutPseudonym, protocol.syncV2RolloutPercentage, protocol.rolloutSaltVersion,
    );
    const upgradeRequired = !readCompatible || !writeCompatible || !schemaCompatible || !appCompatible;
    const pullAllowed = rolloutEligible && protocol.featureFlags.remotePullEnabled && readCompatible && schemaCompatible && !stopped;
    const writesAllowed = rolloutEligible && protocol.featureFlags.syncWritesEnabled && !upgradeRequired && !stopped;
    await this.health.updateSyncHealth({
      accountId: runtime.accountId,
      localSequence: runtime.lastAppliedSequence,
      remoteSequence: undefined,
      authState: 'VALID',
      integrityState: stopped ? 'SAFETY_STOP' : upgradeRequired ? 'WARNING' : 'HEALTHY',
      lastErrorCode: upgradeRequired ? 'PROTOCOL_INCOMPATIBLE' : stopped?.errorCode,
      lastErrorAt: upgradeRequired || stopped ? this.now() : undefined,
    });
    return { runtime, protocol, pullAllowed, writesAllowed, upgradeRequired };
  }
}
