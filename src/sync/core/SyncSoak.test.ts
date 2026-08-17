import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryDataStore } from '../testSupport';
import { SyncError } from '../errors';
import {
  PersistentOutboxRepository,
  SYNC_OPERATION_STATES,
  type SyncOperation,
  type SyncOperationState,
} from '../outbox';
import type { SyncHealthStore } from '../health/SyncHealthService';
import type {
  InitiateSyncOperationRequest,
  InitiateSyncOperationResponse,
  PullSyncEventsResponse,
  SyncCommitResult,
  SyncOperationStatus,
  SyncRemoteEvent,
} from './api/SyncApiTypes';
import { PersistentSyncConflictStore } from './conflict/PersistentSyncConflictStore';
import { SyncInvariantValidator } from './domain/SyncInvariantValidator';
import { BoundedObjectTransfer, sha256Hex } from './operation/BoundedObjectTransfer';
import { PersistentOperationAcknowledgmentStore } from './operation/PersistentOperationAcknowledgmentStore';
import { SyncOperationProcessor } from './operation/SyncOperationProcessor';
import { SyncRuntimeStore, type SyncLocalRuntime } from './protocol/ProtocolBootstrap';
import { RemoteEventPuller } from './replay/RemoteEventPuller';
import type { DecryptedSyncEvent, ReplayBatchEvent, SyncReplayStore } from './replay/PersistentReplayStore';
import { PersistentSafetyStopStore } from './safety/PersistentSafetyStopStore';

const ACCOUNT_ID = 'soak-account';
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const RECORDS_KEY = 'soak_applied_records';

interface SoakPayload {
  deviceId: string;
  cycle: number;
  value: string;
}

interface StoredServerOperation {
  request: InitiateSyncOperationRequest;
  result?: SyncCommitResult;
}

class SoakServer {
  online = true;
  private readonly devices = new Map<string, 'primary_mobile' | 'web_companion'>();
  private readonly objects = new Map<string, Uint8Array>();
  private readonly operations = new Map<string, StoredServerOperation>();
  private readonly events: SyncRemoteEvent[] = [];
  private readonly cursors = new Map<string, number>();
  private readonly versions = new Map<string, number>();

  async initiateOperation(
    request: InitiateSyncOperationRequest,
  ): Promise<InitiateSyncOperationResponse> {
    this.requireOnline();
    const existing = this.operations.get(request.operationId);
    if (
      existing &&
      (existing.request.deviceId !== request.deviceId ||
        existing.request.recordType !== request.recordType ||
        existing.request.recordId !== request.recordId ||
        existing.request.operationType !== request.operationType ||
        existing.request.baseRecordVersion !== request.baseRecordVersion ||
        JSON.stringify(existing.request.objects) !== JSON.stringify(request.objects))
    ) {
      throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
    }
    if (!existing) this.operations.set(request.operationId, { request });
    return {
      operationId: request.operationId,
      status: existing?.result ? 'COMMITTED' : 'OBJECTS_PENDING',
      existing: Boolean(existing),
      uploads: request.objects.map((object) => ({
        objectKey: object.objectKey,
        uploadUrl: `memory://upload/${encodeURIComponent(object.objectKey)}`,
        headers: {},
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        uploaded: this.objects.has(object.objectKey),
      })),
    };
  }

  async commitOperation(operationId: string): Promise<SyncCommitResult> {
    this.requireOnline();
    const stored = this.operations.get(operationId);
    if (!stored) throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
    if (stored.result) return stored.result;
    const eventObject = stored.request.objects.find((object) => object.objectKind === 'EVENT');
    if (!eventObject || !this.objects.has(eventObject.objectKey)) {
      throw new SyncError({ code: 'OBJECT_UPLOAD_FAILED', retryable: true });
    }
    const recordKey = `${stored.request.recordType}:${stored.request.recordId}`;
    const recordVersion = (this.versions.get(recordKey) || 0) + 1;
    this.versions.set(recordKey, recordVersion);
    const sequence = this.events.length + 1;
    stored.result = { status: 'COMMITTED', operationId, sequence, recordVersion };
    this.events.push({
      sequence,
      eventId: `event-${sequence}`,
      operationId,
      deviceId: stored.request.deviceId,
      recordType: stored.request.recordType,
      recordId: stored.request.recordId,
      operationType: stored.request.operationType,
      recordVersion,
      keyEpoch: stored.request.keyEpoch,
      partitionKey: stored.request.partitionKey,
      objectKey: eventObject.objectKey,
      sha256: eventObject.sha256,
      sizeBytes: eventObject.sizeBytes,
      eventSchemaVersion: stored.request.eventSchemaVersion,
      downloadUrl: `memory://download/${encodeURIComponent(eventObject.objectKey)}`,
      downloadExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    return stored.result;
  }

  async getOperation(operationId: string): Promise<SyncOperationStatus> {
    this.requireOnline();
    const stored = this.operations.get(operationId);
    return {
      operationId,
      status: stored?.result ? 'COMMITTED' : stored ? 'OBJECTS_PENDING' : 'NOT_FOUND',
      sequence: stored?.result?.sequence ?? null,
      recordVersion: stored?.result?.recordVersion ?? null,
      lastErrorCode: null,
    };
  }

  async pullEvents(after: number, limit: number): Promise<PullSyncEventsResponse> {
    this.requireOnline();
    const events = this.events.filter((event) => event.sequence > after).slice(0, limit);
    return {
      events,
      currentSequence: this.events.length,
      hasMore: events.length > 0 && events.at(-1)!.sequence < this.events.length,
    };
  }

  async acknowledgeCursor(deviceId: string, sequence: number): Promise<void> {
    this.requireOnline();
    this.cursors.set(deviceId, Math.max(this.cursors.get(deviceId) || 0, sequence));
  }

  readonly fetch: typeof fetch = async (input, init) => {
    this.requireOnline();
    const url = String(input);
    const objectKey = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));
    if (url.startsWith('memory://upload/')) {
      const bytes = new Uint8Array(await new Response(init?.body).arrayBuffer());
      this.objects.set(objectKey, bytes);
      return new Response(null, { status: 200 });
    }
    if (url.startsWith('memory://download/')) {
      const bytes = this.objects.get(objectKey);
      return bytes ? new Response(bytes, { status: 200 }) : new Response(null, { status: 404 });
    }
    return new Response(null, { status: 404 });
  };

  get sequence(): number {
    return this.events.length;
  }

  cursor(deviceId: string): number {
    return this.cursors.get(deviceId) || 0;
  }

  registerDevice(deviceId: string, role: 'primary_mobile' | 'web_companion'): void {
    this.devices.set(deviceId, role);
  }

  get activeCompanionCount(): number {
    return [...this.devices.values()].filter((role) => role === 'web_companion').length;
  }

  async prime(operation: SyncOperation, commit: boolean): Promise<SyncCommitResult | undefined> {
    const bytes = preparedBytes(operation);
    const sha256 = await sha256Hex(bytes);
    const request = operationRequest(operation, bytes, sha256);
    this.operations.set(operation.operationId, { request });
    this.objects.set(request.objects[0].objectKey, bytes);
    return commit ? this.commitOperation(operation.operationId) : undefined;
  }

  private requireOnline(): void {
    if (!this.online) throw new SyncError({ code: 'OFFLINE', retryable: true });
  }
}

const runtime = (deviceId: string): SyncLocalRuntime => ({
  accountId: ACCOUNT_ID,
  deviceId,
  deviceStatus: 'ACTIVE',
  protocolVersion: 2,
  eventSchemaVersion: 2,
  keyEpoch: 1,
  appliedSequence: 0,
  updatedAt: 1,
});

const operation = (
  deviceId: string,
  cycle: number,
  state: SyncOperationState = 'PENDING',
): SyncOperation => ({
  operationId: `${deviceId}-operation-${cycle}`,
  accountId: ACCOUNT_ID,
  deviceId,
  recordType: 'NOTE',
  recordId: `${deviceId}-record-${cycle}`,
  operationType: 'UPSERT',
  baseRecordVersion: 0,
  sourceCanonicalPayload: { deviceId, cycle, value: `${deviceId}:${cycle}` } satisfies SoakPayload,
  state,
  retryCount: state === 'RETRY_WAIT' ? 1 : 0,
  nextAttemptAt: state === 'RETRY_WAIT' ? 999_999 : 0,
  createdAt: cycle + 1,
  updatedAt: cycle + 1,
});

const preparedEvent = (candidate: SyncOperation): DecryptedSyncEvent => ({
  accountId: candidate.accountId,
  operationId: candidate.operationId,
  recordType: candidate.recordType,
  recordId: candidate.recordId,
  operationType: candidate.operationType,
  recordVersion: candidate.baseRecordVersion + 1,
  keyEpoch: 1,
  payload: candidate.sourceCanonicalPayload ?? null,
});

const preparedBytes = (candidate: SyncOperation): Uint8Array =>
  encoder.encode(JSON.stringify(preparedEvent(candidate)));

const operationRequest = (
  candidate: SyncOperation,
  bytes: Uint8Array,
  sha256: string,
): InitiateSyncOperationRequest => ({
  operationId: candidate.operationId,
  deviceId: candidate.deviceId,
  recordType: candidate.recordType,
  recordId: candidate.recordId,
  operationType: candidate.operationType,
  baseRecordVersion: candidate.baseRecordVersion,
  protocolVersion: 2,
  eventSchemaVersion: 2,
  keyEpoch: 1,
  partitionKey: 'notes',
  objects: [
    {
      objectKey: `${candidate.operationId}-event`,
      objectKind: 'EVENT',
      sha256,
      sizeBytes: bytes.byteLength,
    },
  ],
});

class SoakReplayStore implements SyncReplayStore {
  constructor(
    private readonly store: MemoryDataStore,
    private readonly validator: SyncInvariantValidator,
  ) {}

  async getLastAppliedSequence(): Promise<number> {
    return (await new SyncRuntimeStore(this.store).load())?.appliedSequence || 0;
  }

  async hasAppliedEvent(eventId: string): Promise<boolean> {
    const raw = await this.store.getItem('soak_applied_event_ids');
    return raw ? (JSON.parse(raw) as string[]).includes(eventId) : false;
  }

  async applyBatch(events: ReplayBatchEvent[]): Promise<number> {
    const runtimeStore = new SyncRuntimeStore(this.store);
    const currentRuntime = await runtimeStore.load();
    if (!currentRuntime) throw new SyncError({ code: 'LOCAL_DATABASE_FAILURE', safetyRelevant: true });
    const rawRecords = await this.store.getItem(RECORDS_KEY);
    const records = rawRecords ? (JSON.parse(rawRecords) as Record<string, unknown>) : {};
    const rawApplied = await this.store.getItem('soak_applied_event_ids');
    const applied = new Set(rawApplied ? (JSON.parse(rawApplied) as string[]) : []);
    let sequence = currentRuntime.appliedSequence;
    for (const row of events) {
      this.validator.validateEventEnvelope(row.envelope, row.event, ACCOUNT_ID);
      if (applied.has(row.envelope.eventId)) continue;
      this.validator.validateCursorAdvance(sequence, row.envelope.sequence, row.envelope.sequence);
      const key = `${row.event.recordType}:${row.event.recordId}`;
      if (row.event.operationType === 'DELETE') delete records[key];
      else records[key] = row.event.payload;
      applied.add(row.envelope.eventId);
      sequence = row.envelope.sequence;
    }
    await this.store.setItems({
      [RECORDS_KEY]: JSON.stringify(records),
      soak_applied_event_ids: JSON.stringify([...applied]),
    });
    await runtimeStore.save({ ...currentRuntime, appliedSequence: sequence, updatedAt: Date.now() });
    return sequence;
  }
}

const health: SyncHealthStore = { updateSyncHealth: async () => undefined };

class SoakDevice {
  private readonly outbox: PersistentOutboxRepository;
  private readonly validator = new SyncInvariantValidator();

  constructor(
    readonly deviceId: string,
    readonly role: 'primary_mobile' | 'web_companion',
    readonly store: MemoryDataStore,
    private readonly server: SoakServer,
    private readonly now: number,
  ) {
    this.outbox = new PersistentOutboxRepository(store);
  }

  static async create(
    deviceId: string,
    role: 'primary_mobile' | 'web_companion',
    server: SoakServer,
  ): Promise<SoakDevice> {
    const store = new MemoryDataStore();
    await new SyncRuntimeStore(store).save(runtime(deviceId));
    server.registerDevice(deviceId, role);
    return new SoakDevice(deviceId, role, store, server, 1);
  }

  restart(now: number): SoakDevice {
    return new SoakDevice(this.deviceId, this.role, this.store, this.server, now);
  }

  enqueue(cycle: number, state: SyncOperationState = 'PENDING'): Promise<void> {
    return this.outbox.enqueue(operation(this.deviceId, cycle, state));
  }

  async drain(): Promise<void> {
    await this.outbox.releaseExpiredLeases(ACCOUNT_ID, this.now);
    await this.outbox.retryWaitingNow(ACCOUNT_ID, this.now);
    const processor = this.processor();
    for (let attempts = 0; attempts < 10_000; attempts += 1) {
      if (!(await processor.runOnce())) return;
    }
    throw new Error(`Outbox for ${this.deviceId} did not drain.`);
  }

  async runOnce(): Promise<boolean> {
    return this.processor().runOnce();
  }

  async pull(): Promise<number> {
    const transfer = new BoundedObjectTransfer({
      maximumObjectBytes: 64 * 1024,
      fetch: this.server.fetch,
      maximumAttempts: 1,
    });
    return new RemoteEventPuller(
      {
        pullEvents: (after, limit) => this.server.pullEvents(after, limit),
        acknowledgeCursor: (deviceId, sequence) => this.server.acknowledgeCursor(deviceId, sequence),
      },
      transfer,
      {
        hasKeyEpoch: async (epoch) => epoch === 1,
        decrypt: async (bytes) => JSON.parse(decoder.decode(bytes)) as DecryptedSyncEvent,
      },
      new SoakReplayStore(this.store, this.validator),
      this.validator,
      new PersistentSafetyStopStore(this.store),
      health,
      { accountId: ACCOUNT_ID, deviceId: this.deviceId, eventSchemaVersion: 2, pageSize: 37 },
    ).pull();
  }

  listOutbox(): Promise<SyncOperation[]> {
    return this.outbox.listByAccount(ACCOUNT_ID);
  }

  async records(): Promise<Record<string, unknown>> {
    return JSON.parse((await this.store.getItem(RECORDS_KEY)) || '{}') as Record<string, unknown>;
  }

  private processor(): SyncOperationProcessor {
    const transfer = new BoundedObjectTransfer({
      maximumObjectBytes: 64 * 1024,
      fetch: this.server.fetch,
      maximumAttempts: 1,
    });
    return new SyncOperationProcessor(
      this.outbox,
      {
        initiateOperation: (request) => this.server.initiateOperation(request),
        commitOperation: (operationId) => this.server.commitOperation(operationId),
        getOperation: (operationId) => this.server.getOperation(operationId),
      },
      transfer,
      {
        prepare: async (candidate) => {
          const bytes = preparedBytes(candidate);
          return {
            partitionKey: 'notes',
            keyEpoch: 1,
            eventSchemaVersion: 2,
            canonicalPayload: candidate.sourceCanonicalPayload,
            objects: [
              { objectKey: `${candidate.operationId}-event`, objectKind: 'EVENT', bytes },
            ],
          };
        },
      },
      new PersistentOperationAcknowledgmentStore(this.store, 200, () => this.now),
      new PersistentSyncConflictStore(this.store),
      this.validator,
      new PersistentSafetyStopStore(this.store),
      {
        accountId: ACCOUNT_ID,
        deviceId: this.deviceId,
        protocolVersion: 2,
        workerId: `${this.deviceId}-worker-${this.now}`,
        leaseDurationMs: 10,
        now: () => this.now,
        random: () => 0,
      },
    );
  }
}

const RESUMABLE_STATES = new Set<SyncOperationState>([
  'PENDING',
  'PREPARING',
  'UPLOADING',
  'READY_TO_COMMIT',
  'COMMITTING',
  'COMMITTED',
  'RETRY_WAIT',
]);
const STABLE_STATES = new Set<SyncOperationState>([
  'ACKNOWLEDGED',
  'CONFLICT',
  'BLOCKED_AUTH',
  'BLOCKED_DEVICE',
  'BLOCKED_UPGRADE',
  'BLOCKED_QUOTA',
  'SAFETY_STOP',
  'SUPERSEDED',
]);

test('forced process death preserves and correctly resumes or holds every outbox state', async () => {
  assert.equal(RESUMABLE_STATES.size + STABLE_STATES.size, SYNC_OPERATION_STATES.length);
  for (const [index, state] of SYNC_OPERATION_STATES.entries()) {
    const server = new SoakServer();
    let device = await SoakDevice.create(`state-${state.toLowerCase()}`, 'primary_mobile', server);
    const candidate = operation(device.deviceId, index, state);
    if (['UPLOADING', 'READY_TO_COMMIT', 'COMMITTING'].includes(state)) {
      const result = await server.prime(candidate, false);
      assert.equal(result, undefined);
    }
    if (state === 'COMMITTED') {
      const result = await server.prime(candidate, true);
      candidate.remoteSequence = result!.sequence;
      candidate.remoteRecordVersion = result!.recordVersion;
    }
    candidate.leaseOwner = 'dead-process';
    candidate.leaseExpiresAt = 10;
    await new PersistentOutboxRepository(device.store).enqueue(candidate);

    device = device.restart(100);
    await device.drain();
    const persisted = (await device.listOutbox())[0];
    if (RESUMABLE_STATES.has(state)) assert.equal(persisted.state, 'ACKNOWLEDGED', state);
    else assert.equal(persisted.state, state, state);
  }
});

test('primary and two active companions converge through repeated offline cycles and process deaths', async () => {
  const cycles = Math.max(25, Number(process.env.SYNC_SOAK_CYCLES || 250));
  const server = new SoakServer();
  let devices = [
    await SoakDevice.create('primary', 'primary_mobile', server),
    await SoakDevice.create('companion-a', 'web_companion', server),
    await SoakDevice.create('companion-b', 'web_companion', server),
  ];
  assert.equal(devices.filter((device) => device.role === 'web_companion').length, 2);
  assert.equal(server.activeCompanionCount, 2);

  for (let cycle = 0; cycle < cycles; cycle += 1) {
    server.online = false;
    for (const device of devices) {
      await device.enqueue(cycle);
      assert.equal(await device.runOnce(), true);
      assert.equal((await device.listOutbox()).at(-1)?.state, 'RETRY_WAIT');
    }

    devices = devices.map((device, index) => device.restart((cycle + 1) * 100 + index));
    server.online = true;
    for (const device of devices) await device.drain();
    if (cycle % 5 === 0) {
      devices = devices.map((device, index) => device.restart((cycle + 1) * 1_000 + index));
    }
    if ((cycle + 1) % 10 === 0 || cycle === cycles - 1) {
      for (const device of devices) await device.pull();
      const checkpointRecords = await Promise.all(devices.map((device) => device.records()));
      assert.deepEqual(checkpointRecords[1], checkpointRecords[0]);
      assert.deepEqual(checkpointRecords[2], checkpointRecords[0]);
    }
  }

  const expectedEvents = cycles * devices.length;
  assert.equal(server.sequence, expectedEvents);
  assert.equal(server.activeCompanionCount, 2);
  const records = await Promise.all(devices.map((device) => device.records()));
  for (const device of devices) {
    assert.equal(server.cursor(device.deviceId), expectedEvents);
    assert.equal((await device.listOutbox()).filter((row) => row.state !== 'ACKNOWLEDGED').length, 0);
  }
  assert.equal(Object.keys(records[0]).length, expectedEvents);
  assert.deepEqual(records[1], records[0]);
  assert.deepEqual(records[2], records[0]);
});
