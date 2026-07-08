import type { DiaryRepository, RepositorySnapshot } from '../repositories/DiaryRepository';
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import type {
  Diary,
  Entry,
  Note,
  AppSettings,
  GoogleAccountSession,
  LocalSyncAccountState,
  SyncDomainEvent,
  SyncEventOperation,
  SyncOutboxDriveObject,
  SyncOutboxOperation,
  SyncObjectMetadata,
  SyncRecordType,
  UserProfile,
} from '../types';
import { restoreGoogleDriveSession, startGoogleAuth } from '../utils/googleAuth';
import { isNativePlatform } from '../platform';
import { getConfiguredSupabaseAnonKey, getConfiguredSupabaseUrl } from './config';
import { createSyncDomainEvent, encodeSyncDomainEvent } from './domainEvents';
import {
  getDriveStorageQuota,
  downloadDriveSyncObject,
  listDriveSyncObjects,
  uploadDriveSyncObject,
  type DriveStorageQuota,
  type DriveSyncObjectSummary,
  type UploadDriveSyncObjectInput,
} from './driveSyncObjects';
import { decryptSyncPayload, encryptSyncPayload } from './encryptedSyncObject';
import { replaySyncObjects } from './eventReplay';
import { decodeCompanionKeyPackage, unwrapRootKeysForCompanion } from './companionKeyPackage';
import { refreshSupabaseSession } from './supabaseAuth';
import { exchangeGoogleIdTokenForSupabaseSession } from './supabaseAuth';
import { SupabaseControlPlaneClient, SupabaseControlPlaneError } from './supabaseControlPlane';
import {
  clearSyncSecrets,
  getAccountRootKeyForEpoch,
  loadSyncSecrets,
  saveSyncSecrets,
  withAccountRootKeyForEpoch,
  type SyncSecrets,
} from './syncSecrets';
import { exportRepositorySnapshotPayload } from './syncSnapshot';
import {
  listPartitionKeysInSnapshot,
  partitionKeyForRecordPayload,
  recentPartitionKeys,
} from './syncPartitioning';
import { hydrateArchivePartition as hydrateArchivePartitionFromCloud } from './partitionedRestore';
import {
  cacheSyncMedia,
  createStableSyncMediaReference,
  createImageThumbnail,
  decodeSyncMediaPayload,
  encodeSyncMediaPayload,
  encodeSyncThumbnailPayload,
  parseSyncMediaReference,
  readMediaUri,
} from './syncMedia';
import { downloadVerifiedSyncObject, type SyncObjectDownloader } from './eventReplay';
import { restoreWebGoogleSyncSession, startWebGoogleSyncSignIn } from './webGoogleAuth';
import { performSyncMaintenance } from './syncMaintenance';
import { migrateLocalAccountToPartitionedSync } from './partitionedMigration';
import {
  shouldBackgroundHydrateArchive,
  type ArchiveHydrationDecision,
  type ArchiveHydrationPolicyInput,
} from './partitionHydrationPolicy';
import { emitSyncTelemetry } from './syncTelemetry';
import { sanitizeEntry, sanitizeNote } from '../domain/richTextSanitizer';

type SyncPayload = NonNullable<SyncDomainEvent['payload']>;

const sanitizeSyncPayload = (
  recordType: SyncRecordType,
  payload: SyncPayload | null,
): SyncPayload | null => {
  if (!payload) return payload;
  if (recordType === 'entry') return sanitizeEntry(payload as Entry);
  if (recordType === 'note') return sanitizeNote(payload as Note);
  return payload;
};

interface PreparedMediaUpload {
  mediaId: string;
  localUri: string;
  driveFileId: string;
  mediaKind: 'image' | 'audio' | 'file';
  sha256: string;
  sizeBytes: number;
  reference: string;
  thumbnail?: {
    driveFileId: string;
    sha256: string;
    sizeBytes: number;
  };
}

const outboxMediaObjectsFromPrepared = (
  preparedMedia: PreparedMediaUpload[],
  partitionKey: string,
): SyncOutboxDriveObject[] => preparedMedia.map(media => ({
  driveFileId: media.driveFileId,
  objectKind: 'media',
  sha256: media.sha256,
  sizeBytes: media.sizeBytes,
  partitionKey,
  mediaId: media.mediaId,
  localUri: media.localUri,
  reference: media.reference,
  thumbnail: media.thumbnail,
}));

const preparedMediaFromOutbox = (objects: SyncOutboxDriveObject[] | undefined): PreparedMediaUpload[] => (
  (objects || [])
    .filter(object => object.objectKind === 'media' && object.mediaId && object.localUri && object.reference)
    .map(object => ({
      mediaId: object.mediaId!,
      localUri: object.localUri!,
      driveFileId: object.driveFileId,
      mediaKind: 'file',
      sha256: object.sha256,
      sizeBytes: object.sizeBytes,
      reference: object.reference!,
      thumbnail: object.thumbnail,
    }))
);

type SyncThumbnailGenerator = (
  media: { bytes: Uint8Array; mimeType: string },
) => Promise<{ bytes: Uint8Array; mimeType: string } | null>;

export interface EventSyncEngineDependencies {
  isOnline?: () => boolean;
  loadSecrets?: () => Promise<SyncSecrets | null>;
  saveSecrets?: (secrets: SyncSecrets) => Promise<void>;
  restoreGoogleSession?: (secrets: SyncSecrets) => Promise<GoogleAccountSession | null>;
  createControlPlane?: (accessToken: string) => SupabaseControlPlaneClient;
  upload?: (input: UploadDriveSyncObjectInput) => Promise<{ id: string }>;
  download?: SyncObjectDownloader;
  now?: () => number;
  snapshotIntervalEvents?: number;
  maintenance?: typeof performSyncMaintenance;
  maintenanceIntervalMs?: number;
  getArchiveHydrationPolicyInput?: () => ArchiveHydrationPolicyInput | Promise<ArchiveHydrationPolicyInput>;
  backgroundArchiveBatchSize?: number;
  createThumbnail?: SyncThumbnailGenerator;
}

export const DEFAULT_SNAPSHOT_INTERVAL_EVENTS = 100;

const timestampForDriveFile = (file: DriveSyncObjectSummary): number => {
  const timestamp = file.modifiedTime || file.createdTime;
  return timestamp ? Date.parse(timestamp) || 0 : 0;
};

const mediaKindFromMimeType = (mimeType: string): PreparedMediaUpload['mediaKind'] => {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'file';
};

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
};

const buildStorageBreakdown = (files: DriveSyncObjectSummary[]): DriveSyncStorageBreakdown => {
  const legacyImageSourceIds = new Set(
    files
      .filter(file => file.appProperties?.objectKind === 'thumbnail')
      .map(file => file.appProperties?.sourceDriveFileId)
      .filter((fileId): fileId is string => Boolean(fileId)),
  );
  let imageBytes = 0;
  let audioBytes = 0;
  let journalDataBytes = 0;
  files.forEach(file => {
    const size = file.size || 0;
    const kind = file.appProperties?.mediaKind;
    const objectKind = file.appProperties?.objectKind;
    if (kind === 'image' || objectKind === 'thumbnail' || legacyImageSourceIds.has(file.id)) {
      imageBytes += size;
    } else if (kind === 'audio' || objectKind === 'media') {
      audioBytes += size;
    } else {
      journalDataBytes += size;
    }
  });
  return { journalDataBytes, imageBytes, audioBytes };
};

export interface BackgroundArchiveHydrationResult {
  decision: ArchiveHydrationDecision;
  hydratedPartitionKeys: string[];
}

export interface DriveSyncStorageBreakdown {
  journalDataBytes: number;
  imageBytes: number;
  audioBytes: number;
}

export interface DriveSyncStatus {
  accountEmail: string;
  appStorageBytes: number;
  storageQuota: DriveStorageQuota | null;
  storageBreakdown: DriveSyncStorageBreakdown;
  lastUploadAt: string | null;
  recoveryKeyDriveFileId: string;
  latestSnapshotDriveFileId: string;
  latestManifestDriveFileId?: string;
}

const defaultArchiveHydrationPolicyInput = async (
  isOnline: () => boolean,
): Promise<ArchiveHydrationPolicyInput> => {
  const nav = typeof navigator === 'undefined' ? undefined : navigator as any;
  const connection = nav?.connection || nav?.mozConnection || nav?.webkitConnection;
  const connectionType = String(connection?.type || '').toLowerCase();
  const effectiveType = String(connection?.effectiveType || '').toLowerCase();
  const isCellular = connectionType === 'cellular' || ['slow-2g', '2g', '3g'].includes(effectiveType);
  let isCharging = true;
  let batteryLevel = 1;
  try {
    if (typeof nav?.getBattery === 'function') {
      const battery = await nav.getBattery();
      isCharging = Boolean(battery?.charging);
      batteryLevel = typeof battery?.level === 'number' ? battery.level : 1;
    }
  } catch {
    isCharging = true;
    batteryLevel = 1;
  }
  return {
    isOnline: isOnline(),
    isWifi: !isCellular,
    isCharging,
    batteryLevel,
    userAllowedMobileData: false,
    storagePressure: 'normal',
  };
};

const collectLiveMediaDriveFileIds = (snapshot: RepositorySnapshot): Set<string> => {
  const live = new Set<string>();
  const pointers = Object.values(snapshot.syncMediaPointers || {});
  const addPointer = (pointer: (typeof pointers)[number] | undefined) => {
    if (!pointer) return;
    live.add(pointer.driveFileId);
    if (pointer.thumbnailDriveFileId) live.add(pointer.thumbnailDriveFileId);
  };
  const addReference = (reference?: string) => {
    const parsed = parseSyncMediaReference(reference);
    if (!parsed) return;
    if (parsed.driveFileId) live.add(parsed.driveFileId);
    addPointer(
      parsed.sequence
        ? pointers.find(pointer => pointer.sequence === parsed.sequence)
        : pointers.find(pointer => (
            (!!parsed.driveFileId && pointer.driveFileId === parsed.driveFileId) ||
            (!!parsed.mediaId && pointer.mediaId === parsed.mediaId)
          )),
    );
  };

  snapshot.diaries.forEach(diary => addReference(diary.coverImage));
  snapshot.entries.forEach(entry => {
    entry.photoUris.forEach(addReference);
    addReference(entry.audioUri);
    (entry.blocks || []).forEach(block => addReference(block.audioUri));
  });
  addReference(snapshot.userProfile?.avatarUri);
  return live;
};

export class SyncConflictError extends Error {
  constructor(message: string, readonly recoveredRecordId?: string) {
    super(message);
    this.name = 'SyncConflictError';
  }
}

export class EventSyncEngine {
  private operationTail: Promise<void> = Promise.resolve();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private realtimeClient: SupabaseClient | null = null;
  private realtimeChannel: RealtimeChannel | null = null;
  private readonly isOnline: () => boolean;
  private readonly loadSecrets: () => Promise<SyncSecrets | null>;
  private readonly saveSecrets: (secrets: SyncSecrets) => Promise<void>;
  private readonly restoreGoogleSession: (secrets: SyncSecrets) => Promise<GoogleAccountSession | null>;
  private readonly createControlPlane: (accessToken: string) => SupabaseControlPlaneClient;
  private readonly upload: (input: UploadDriveSyncObjectInput) => Promise<{ id: string }>;
  private readonly download?: SyncObjectDownloader;
  private readonly now: () => number;
  private readonly snapshotIntervalEvents: number;
  private readonly maintenance: typeof performSyncMaintenance;
  private readonly maintenanceIntervalMs: number;
  private readonly getArchiveHydrationPolicyInput: () => ArchiveHydrationPolicyInput | Promise<ArchiveHydrationPolicyInput>;
  private readonly backgroundArchiveBatchSize: number;
  private readonly createThumbnail: SyncThumbnailGenerator;
  private lastMaintenanceAt = 0;
  private readonly resolvedMediaReferences = new Map<string, string>();
  private readonly localMediaReferences = new Map<string, string>();

  constructor(
    private readonly repository: DiaryRepository,
    dependencies: EventSyncEngineDependencies = {},
  ) {
    this.isOnline = dependencies.isOnline || (() => typeof navigator === 'undefined' || navigator.onLine);
    this.loadSecrets = dependencies.loadSecrets || (() => loadSyncSecrets());
    this.saveSecrets = dependencies.saveSecrets || (secrets => saveSyncSecrets(secrets));
    this.restoreGoogleSession = dependencies.restoreGoogleSession || (secrets => (
      isNativePlatform() ? restoreGoogleDriveSession(false) : Promise.resolve(secrets.googleSession || null)
    ));
    this.createControlPlane = dependencies.createControlPlane || (accessToken => new SupabaseControlPlaneClient({
      url: getConfiguredSupabaseUrl(),
      anonKey: getConfiguredSupabaseAnonKey(),
      accessToken,
    }));
    this.upload = dependencies.upload || uploadDriveSyncObject;
    this.download = dependencies.download;
    this.now = dependencies.now || Date.now;
    this.snapshotIntervalEvents = dependencies.snapshotIntervalEvents || DEFAULT_SNAPSHOT_INTERVAL_EVENTS;
    this.maintenance = dependencies.maintenance || performSyncMaintenance;
    this.maintenanceIntervalMs = dependencies.maintenanceIntervalMs || 24 * 60 * 60 * 1000;
    this.getArchiveHydrationPolicyInput = dependencies.getArchiveHydrationPolicyInput
      || (() => defaultArchiveHydrationPolicyInput(this.isOnline));
    this.backgroundArchiveBatchSize = Math.max(1, dependencies.backgroundArchiveBatchSize || 1);
    this.createThumbnail = dependencies.createThumbnail || createImageThumbnail;
  }

  commitMutation(
    recordType: SyncRecordType,
    operation: SyncEventOperation,
    recordId: string,
    payload: SyncPayload | null,
  ): Promise<SyncDomainEvent> {
    return this.enqueue(() => this.commitMutationUnlocked(recordType, operation, recordId, payload));
  }

  pullPending(): Promise<void> {
    return this.enqueue(() => this.pullPendingUnlocked());
  }

  createSnapshot(): Promise<SyncObjectMetadata | null> {
    return this.enqueue(async () => {
      this.requireOnline();
      const runtime = await this.openRuntime();
      await this.assertActiveDevice(runtime.controlPlane, runtime.state.deviceId);
      await this.pullWithRuntime(runtime);
      return this.compactSnapshotWithRuntime(runtime, true);
    });
  }

  getDriveSyncStatus(): Promise<DriveSyncStatus> {
    return this.enqueue(async () => {
      this.requireOnline();
      const runtime = await this.openRuntime();
      if (runtime.state.deviceRole === 'primary_mobile') {
        await this.runMaintenanceWithRuntime(runtime, true).catch(error => {
          console.warn('Encrypted sync cleanup before storage status failed:', error);
        });
      }
      const [files, storageQuota] = await Promise.all([
        listDriveSyncObjects(runtime.googleSession),
        getDriveStorageQuota(runtime.googleSession).catch(() => null),
      ]);
      const latestFile = [...files].sort((left, right) => timestampForDriveFile(right) - timestampForDriveFile(left))[0];

      return {
        accountEmail: runtime.state.googleEmail,
        appStorageBytes: files.reduce((sum, file) => sum + (file.size || 0), 0),
        storageQuota,
        storageBreakdown: buildStorageBreakdown(files),
        lastUploadAt: latestFile?.modifiedTime || latestFile?.createdTime || null,
        recoveryKeyDriveFileId: runtime.state.recoveryKeyDriveFileId,
        latestSnapshotDriveFileId: runtime.state.latestSnapshotDriveFileId,
        latestManifestDriveFileId: runtime.state.latestManifestDriveFileId,
      };
    });
  }

  ensurePartitionedSync(): Promise<boolean> {
    return this.enqueue(async () => {
      this.requireOnline();
      const runtime = await this.openRuntime();
      if (runtime.state.deviceRole !== 'primary_mobile') return false;
      if (runtime.state.partitionedSyncEnabled && runtime.state.latestManifestDriveFileId) return false;
      await this.assertActiveDevice(runtime.controlPlane, runtime.state.deviceId);

      const manifest = await runtime.controlPlane.getLatestRestoreManifest(runtime.state.deviceId);
      if (manifest.manifestObject) {
        await this.repository.saveLocalSyncAccountState({
          ...runtime.state,
          partitionedSyncEnabled: true,
          keyEpoch: manifest.keyEpoch,
          latestManifestDriveFileId: manifest.manifestObject.driveFileId,
          latestManifestSequence: manifest.manifestObject.sequence,
        });
        return false;
      }

      await this.pullWithRuntime(runtime);
      const current = await this.repository.getLocalSyncAccountState();
      if (!current) throw new Error('Encrypted account metadata is unavailable.');
      await migrateLocalAccountToPartitionedSync({
        repository: this.repository,
        controlPlane: runtime.controlPlane,
        localState: current,
        accountRootKey: runtime.secrets.accountRootKey,
        googleSession: runtime.googleSession,
        upload: this.upload,
      });
      return true;
    });
  }

  hydrateArchivePartition(partitionKey: string): Promise<void> {
    return this.enqueue(async () => {
      this.requireOnline();
      const runtime = await this.openRuntime();
      await this.assertActiveDevice(runtime.controlPlane, runtime.state.deviceId);
      await this.hydrateArchivePartitionWithRuntime(runtime, partitionKey);
    });
  }

  hydrateBackgroundArchiveOnce(): Promise<BackgroundArchiveHydrationResult> {
    return this.enqueue(async () => {
      const policyInput = await this.getArchiveHydrationPolicyInput();
      const decision = shouldBackgroundHydrateArchive(policyInput);
      emitSyncTelemetry('sync.archive.background.policy', {
        allowed: decision.allowed,
        reason: decision.reason,
        isWifi: policyInput.isWifi,
        isCharging: policyInput.isCharging,
        storagePressure: policyInput.storagePressure || 'normal',
      });
      if (!decision.allowed) return { decision, hydratedPartitionKeys: [] };
      this.requireOnline();

      const state = await this.repository.getLocalSyncAccountState();
      if (!state?.partitionedSyncEnabled) {
        emitSyncTelemetry('sync.archive.background.skipped', { reason: 'partitioned_sync_disabled' });
        return { decision, hydratedPartitionKeys: [] };
      }

      const now = this.now();
      const candidates = (await this.repository.listAvailableArchiveMonths())
        .filter(partition => (
          partition.status === 'available' ||
          (partition.status === 'failed' && (partition.nextRetryAt || 0) <= now)
        ))
        .slice(0, this.backgroundArchiveBatchSize);
      if (candidates.length === 0) {
        emitSyncTelemetry('sync.archive.background.skipped', { reason: 'no_retryable_partitions' });
        return { decision, hydratedPartitionKeys: [] };
      }

      const runtime = await this.openRuntime();
      await this.assertActiveDevice(runtime.controlPlane, runtime.state.deviceId);

      const hydratedPartitionKeys: string[] = [];
      for (const candidate of candidates) {
        try {
          await this.hydrateArchivePartitionWithRuntime(runtime, candidate.partitionKey);
          hydratedPartitionKeys.push(candidate.partitionKey);
        } catch (error: any) {
          emitSyncTelemetry('sync.archive.background.stopped_after_failure', {
            partitionKey: candidate.partitionKey,
            error: error?.message || 'Archive hydration failed.',
          }, 'warn');
          break;
        }
      }
      emitSyncTelemetry('sync.archive.background.complete', {
        attemptedCount: candidates.length,
        hydratedCount: hydratedPartitionKeys.length,
        hydratedPartitionKeys,
      });
      return { decision, hydratedPartitionKeys };
    });
  }

  async reauthorize(): Promise<void> {
    if (!isNativePlatform()) {
      await startWebGoogleSyncSignIn();
      return;
    }
    const state = await this.repository.getLocalSyncAccountState();
    const secrets = await this.loadSecrets();
    if (!state || !secrets) throw new Error('Encrypted account metadata is unavailable.');
    const googleSession = await startGoogleAuth('sync');
    if (googleSession.userId !== state.googleUserId || !googleSession.idToken) {
      throw new Error(`Reconnect ${state.googleEmail} to continue syncing.`);
    }
    const supabaseSession = await exchangeGoogleIdTokenForSupabaseSession({
      supabaseUrl: getConfiguredSupabaseUrl(),
      anonKey: getConfiguredSupabaseAnonKey(),
      googleIdToken: googleSession.idToken,
    });
    await this.saveSecrets({ ...secrets, googleSession, supabaseSession });
  }

  async hydrateDiary(diary: Diary): Promise<Diary> {
    if (!parseSyncMediaReference(diary.coverImage)) return diary;
    return { ...diary, coverImage: await this.resolveMediaReferenceBestEffort(diary.coverImage!, 'diary cover') };
  }

  hydrateDiaries(diaries: Diary[]): Promise<Diary[]> {
    return Promise.all(diaries.map(diary => this.hydrateDiary(diary)));
  }

  async hydrateEntries(entries: Entry[]): Promise<Entry[]> {
    const needsMedia = entries.some(entry => (
      entry.photoUris.some(uri => Boolean(parseSyncMediaReference(uri))) ||
      Boolean(parseSyncMediaReference(entry.audioUri)) ||
      entry.blocks?.some(block => Boolean(parseSyncMediaReference(block.audioUri)))
    ));
    if (!needsMedia) return entries;
    return Promise.all(entries.map(async entry => ({
      ...entry,
      photoUris: await Promise.all(entry.photoUris.map(uri => this.resolveMediaReferenceBestEffort(uri, 'entry photo'))),
      audioUri: entry.audioUri ? await this.resolveMediaReferenceBestEffort(entry.audioUri, 'entry audio') : undefined,
      blocks: entry.blocks ? await Promise.all(entry.blocks.map(async block => ({
        ...block,
        audioUri: block.audioUri ? await this.resolveMediaReferenceBestEffort(block.audioUri, 'entry block audio') : undefined,
      }))) : undefined,
    })));
  }

  async hydrateProfile(profile: UserProfile): Promise<UserProfile> {
    if (!parseSyncMediaReference(profile.avatarUri)) return profile;
    return { ...profile, avatarUri: await this.resolveMediaReferenceBestEffort(profile.avatarUri!, 'profile avatar') };
  }

  hydrateMediaReference(reference: string, label = 'media'): Promise<string> {
    return this.resolveMediaReferenceBestEffort(reference, label);
  }

  startPolling(intervalMs = 15_000): void {
    if (this.pollTimer) return;
    void this.pullPending().catch(error => console.warn('Initial encrypted sync pull failed:', error));
    void this.ensurePartitionedSync().catch(error => console.warn('Partitioned sync migration will be retried:', error));
    void this.hydrateBackgroundArchiveOnce().catch(error => console.warn('Background archive hydration will be retried:', error));
    void this.startRealtime().catch(error => console.warn('Supabase Realtime sync could not start:', error));
    this.pollTimer = setInterval(() => {
      if (!this.isOnline()) return;
      void (async () => {
        await this.pullPending();
        await this.hydrateBackgroundArchiveOnce();
      })().catch(error => console.warn('Encrypted sync pull failed:', error));
    }, intervalMs);
  }

  stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.realtimeClient && this.realtimeChannel) {
      void this.realtimeClient.removeChannel(this.realtimeChannel);
    }
    this.realtimeChannel = null;
    this.realtimeClient = null;
  }

  private async startRealtime(): Promise<void> {
    if (this.realtimeChannel) return;
    const runtime = await this.openRuntime();
    if (!this.pollTimer) return;
    const { createClient } = await import('@supabase/supabase-js');
    const client = createClient(getConfiguredSupabaseUrl(), getConfiguredSupabaseAnonKey(), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    await client.realtime.setAuth(runtime.secrets.supabaseSession.accessToken);
    const channel = client
      .channel(`sync-objects-${runtime.state.accountId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'sync_objects',
          filter: `account_id=eq.${runtime.state.accountId}`,
        },
        () => {
          void this.pullPending().catch(error => console.warn('Realtime encrypted sync pull failed:', error));
        },
      )
      .subscribe((status, error) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          console.warn('Supabase Realtime channel error:', error);
        }
      });
    this.realtimeClient = client;
    this.realtimeChannel = channel;
  }

  private async commitMutationUnlocked(
    recordType: SyncRecordType,
    operation: SyncEventOperation,
    recordId: string,
    payload: SyncPayload | null,
  ): Promise<SyncDomainEvent> {
    this.requireOnline();
    const runtime = await this.openRuntime();
    await this.assertActiveDevice(runtime.controlPlane, runtime.state.deviceId);
    await this.resumeUserWriteOutbox(runtime);
    await this.pullWithRuntime(runtime);

    payload = sanitizeSyncPayload(recordType, payload);
    const originalPayload = payload;
    const state = await this.repository.getLocalSyncAccountState();
    if (!state) throw new Error('Create or recover your encrypted account before editing.');
    const baseRecordVersion = await this.repository.getSyncRecordVersion(recordType, recordId);
    const affectedRecords = recordType === 'diary' && operation === 'delete'
      ? await Promise.all((await this.repository.listEntries())
          .filter(entry => entry.diaryId === recordId)
          .map(async entry => ({
            recordType: 'entry' as const,
            recordId: entry.id,
            baseRecordVersion: await this.repository.getSyncRecordVersion('entry', entry.id),
          })))
      : [];
    const operationId = crypto.randomUUID();
    let outboxOperation: SyncOutboxOperation = {
      operationId,
      accountId: state.accountId,
      deviceId: state.deviceId,
      partitionKey: partitionKeyForRecordPayload(recordType, payload),
      affectedPartitionKeys: [partitionKeyForRecordPayload(recordType, payload)],
      recordType,
      recordId,
      operation,
      payload,
      baseRecordVersion,
      affectedRecords,
      state: 'prepared',
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    await this.repository.saveSyncOutboxOperation(outboxOperation);

    try {
      return await this.executeUserWriteOutboxOperation(runtime, outboxOperation, affectedRecords);
    } catch (error: any) {
      if (
        error instanceof SupabaseControlPlaneError &&
        (error.message.includes('stale_sync_sequence') || error.message.includes('stale_record_version'))
      ) {
        await this.repository.removeSyncOutboxOperation(operationId).catch(() => undefined);
        await this.pullWithRuntime(runtime);
        if (operation === 'upsert' && originalPayload && (recordType === 'entry' || recordType === 'note')) {
          const recoveredId = `${recordType}-recovered-${crypto.randomUUID()}`;
          const recoveredPayload = recordType === 'entry'
            ? {
                ...(originalPayload as Entry),
                id: recoveredId,
                title: `${(originalPayload as Entry).title || 'Untitled entry'} (Recovered copy)`,
                createdAt: this.now(),
                updatedAt: this.now(),
              }
            : {
                ...(originalPayload as Extract<SyncPayload, { title: string }>),
                id: recoveredId,
                title: `${(originalPayload as Extract<SyncPayload, { title: string }>).title || 'Untitled note'} (Recovered copy)`,
                createdAt: this.now(),
                updatedAt: this.now(),
              };
          await this.commitMutationUnlocked(recordType, 'upsert', recoveredId, sanitizeSyncPayload(recordType, recoveredPayload as SyncPayload) as SyncPayload);
          throw new SyncConflictError(
            `This ${recordType} changed on another device. Your pending version was saved as a recovered copy.`,
            recoveredId,
          );
        }
        throw new SyncConflictError('This record changed on another device. The latest version is now loaded.');
      }
      await this.markOutboxOperationFailed(
        operationId,
        error?.message || 'Encrypted sync write failed.',
      ).catch(() => undefined);
      throw error;
    }
  }

  private async updateOutboxOperation(
    operation: SyncOutboxOperation,
    changes: Partial<SyncOutboxOperation>,
  ): Promise<SyncOutboxOperation> {
    const next = {
      ...operation,
      ...changes,
      updatedAt: this.now(),
    };
    await this.repository.saveSyncOutboxOperation(next);
    return next;
  }

  private async resumeUserWriteOutbox(
    runtime: Awaited<ReturnType<EventSyncEngine['openRuntime']>>,
  ): Promise<void> {
    const operations = await this.repository.listSyncOutboxOperations([
      'prepared',
      'media_uploading',
      'media_uploaded',
      'event_uploading',
      'event_uploaded',
      'metadata_committing',
      'committed',
      'applied',
      'failed',
    ]);
    for (const operation of operations) {
      if (!operation.operation) continue;
      await this.executeUserWriteOutboxOperation(runtime, operation);
    }
  }

  private async markOutboxOperationFailed(operationId: string, error: string): Promise<void> {
    const latest = (await this.repository.listSyncOutboxOperations())
      .find(operation => operation.operationId === operationId);
    if (!latest) return;
    await this.updateOutboxOperation(latest, {
      state: 'failed',
      error,
      retryCount: (latest.retryCount || 0) + 1,
      lastErrorAt: this.now(),
    });
  }

  private async executeUserWriteOutboxOperation(
    runtime: Awaited<ReturnType<EventSyncEngine['openRuntime']>>,
    persistedOperation: SyncOutboxOperation,
    affectedRecordsOverride?: Array<{ recordType: 'entry'; recordId: string; baseRecordVersion: number }>,
  ): Promise<SyncDomainEvent> {
    let outboxOperation = persistedOperation;
    if (outboxOperation.error) {
      outboxOperation = await this.updateOutboxOperation(outboxOperation, { error: undefined });
    }
    const operation = outboxOperation.operation;
    if (!operation) throw new Error('Sync outbox operation is missing its mutation type.');
    let payload = sanitizeSyncPayload(outboxOperation.recordType, outboxOperation.payload as SyncPayload | null);
    const state = await this.repository.getLocalSyncAccountState();
    if (!state) throw new Error('Create or recover your encrypted account before editing.');
    const baseRecordVersion = outboxOperation.baseRecordVersion
      ?? await this.repository.getSyncRecordVersion(outboxOperation.recordType, outboxOperation.recordId);
    const affectedRecords = affectedRecordsOverride || outboxOperation.affectedRecords || [];
    let partitionKey = outboxOperation.partitionKey || partitionKeyForRecordPayload(outboxOperation.recordType, payload);
    let preparedMedia = preparedMediaFromOutbox(outboxOperation.uploadedObjects);

    if (!outboxOperation.uploadedObjects || outboxOperation.state === 'prepared' || outboxOperation.state === 'media_uploading') {
      outboxOperation = await this.updateOutboxOperation(outboxOperation, { state: 'media_uploading', error: undefined });
      preparedMedia = [];
      payload = await this.preparePayloadMedia(runtime, outboxOperation.recordType, payload, preparedMedia);
      partitionKey = partitionKeyForRecordPayload(outboxOperation.recordType, payload);
      outboxOperation = await this.updateOutboxOperation(outboxOperation, {
        state: 'media_uploaded',
        payload,
        partitionKey,
        affectedPartitionKeys: [partitionKey],
        uploadedObjects: outboxMediaObjectsFromPrepared(preparedMedia, partitionKey),
      });
    }

    const event = createSyncDomainEvent({
      accountId: state.accountId,
      deviceId: state.deviceId,
      recordType: outboxOperation.recordType,
      operation,
      recordId: outboxOperation.recordId,
      baseRecordVersion,
      payload,
      eventId: outboxOperation.operationId,
      createdAt: new Date(outboxOperation.createdAt).toISOString(),
      affectedRecords,
    });
    const activeKeyEpoch = runtime.state.keyEpoch || state.keyEpoch || 1;
    const activeRootKey = getAccountRootKeyForEpoch(runtime.secrets, activeKeyEpoch);
    let encrypted: { bytes: Uint8Array; sha256: string } | null = null;
    const preparedObjectCount = preparedMedia.reduce((total, media) => total + 1 + (media.thumbnail ? 1 : 0), 0);
    const expectedSequence = state.currentSyncSequence + preparedObjectCount + 1;
    const eventFolder = partitionKey.startsWith('month:') ? partitionKey.slice('month:'.length) : 'core';
    if (!outboxOperation.eventDriveFileId || !outboxOperation.eventSha256 || !outboxOperation.eventSizeBytes) {
      outboxOperation = await this.updateOutboxOperation(outboxOperation, { state: 'event_uploading' });
      encrypted = await encryptSyncPayload(activeRootKey, 'event', encodeSyncDomainEvent(event), { keyEpoch: activeKeyEpoch });
      const file = await this.upload({
        session: runtime.googleSession,
        name: `/events/${eventFolder}/${expectedSequence}-${event.eventId}.ddevent`,
        objectKind: 'event',
        bytes: encrypted.bytes,
        appProperties: {
          accountId: state.accountId,
          eventId: event.eventId,
          recordType: outboxOperation.recordType,
          recordId: outboxOperation.recordId,
          baseRecordVersion,
          partitionKey,
          keyEpoch: activeKeyEpoch,
        },
      });
      outboxOperation = await this.updateOutboxOperation(outboxOperation, {
        state: 'event_uploaded',
        eventDriveFileId: file.id,
        eventSha256: encrypted.sha256,
        eventSizeBytes: encrypted.bytes.byteLength,
      });
    }

    let committedObjects = outboxOperation.committedObjects || [];
    if (committedObjects.length === 0) {
      outboxOperation = await this.updateOutboxOperation(outboxOperation, { state: 'metadata_committing' });
      committedObjects = preparedMedia.length > 0
        ? await runtime.controlPlane.commitSyncBatch({
            deviceId: state.deviceId,
            operationId: event.eventId,
            objects: [
              ...preparedMedia.flatMap(media => [
                {
                  driveFileId: media.driveFileId,
                  objectKind: 'media' as const,
                  sha256: media.sha256,
                  sizeBytes: media.sizeBytes,
                  partitionKey,
                },
                ...(media.thumbnail ? [{
                  driveFileId: media.thumbnail.driveFileId,
                  objectKind: 'thumbnail' as const,
                  sha256: media.thumbnail.sha256,
                  sizeBytes: media.thumbnail.sizeBytes,
                  partitionKey,
                }] : []),
              ]),
              {
                driveFileId: outboxOperation.eventDriveFileId!,
                objectKind: 'event' as const,
                sha256: outboxOperation.eventSha256!,
                sizeBytes: outboxOperation.eventSizeBytes!,
                partitionKey,
              },
            ],
            recordType: outboxOperation.recordType,
            recordId: outboxOperation.recordId,
            baseRecordVersion,
            affectedRecords: event.affectedRecords,
            partitionKey,
            affectedPartitionKeys: [partitionKey],
            keyEpoch: activeKeyEpoch,
          })
        : [await runtime.controlPlane.commitSyncObject({
            deviceId: state.deviceId,
            afterSequence: state.currentSyncSequence,
            driveFileId: outboxOperation.eventDriveFileId!,
            objectKind: 'event',
            sha256: outboxOperation.eventSha256!,
            sizeBytes: outboxOperation.eventSizeBytes!,
            recordType: outboxOperation.recordType,
            recordId: outboxOperation.recordId,
            baseRecordVersion,
            affectedRecords: event.affectedRecords,
            partitionKey,
            affectedPartitionKeys: [partitionKey],
            operationId: event.eventId,
            keyEpoch: activeKeyEpoch,
          })];
      outboxOperation = await this.updateOutboxOperation(outboxOperation, {
        state: 'committed',
        committedObjects,
      });
    }

    const committed = committedObjects.find(object => object.objectKind === 'event');
    if (!committed) throw new Error('Committed sync batch did not include the encrypted event.');
    for (const media of preparedMedia) {
      const mediaObject = committedObjects.find(object => object.objectKind === 'media' && object.driveFileId === media.driveFileId);
      if (!mediaObject) throw new Error('Committed sync batch did not include an encrypted media object.');
      await this.repository.saveSyncMediaPointer({
        mediaId: media.mediaId,
        sequence: mediaObject.sequence,
        driveFileId: mediaObject.driveFileId,
        sha256: mediaObject.sha256,
        sizeBytes: mediaObject.sizeBytes,
        createdByDeviceId: mediaObject.createdByDeviceId,
        createdAt: mediaObject.createdAt,
        localUri: media.localUri,
        keyEpoch: mediaObject.keyEpoch || activeKeyEpoch,
        ...(() => {
          const thumbnailObject = media.thumbnail
            ? committedObjects.find(object => object.objectKind === 'thumbnail' && object.driveFileId === media.thumbnail?.driveFileId)
            : null;
          return thumbnailObject ? {
            thumbnailSequence: thumbnailObject.sequence,
            thumbnailDriveFileId: thumbnailObject.driveFileId,
            thumbnailSha256: thumbnailObject.sha256,
            thumbnailSizeBytes: thumbnailObject.sizeBytes,
          } : {};
        })(),
      });
      this.localMediaReferences.set(media.localUri, media.reference);
      this.resolvedMediaReferences.set(media.reference, media.localUri);
    }
    if (committed.recordVersion !== event.recordVersion) {
      throw new Error('The committed record version does not match the encrypted event.');
    }
    if (JSON.stringify(committed.affectedRecords || []) !== JSON.stringify(event.affectedRecords || [])) {
      throw new Error('Committed affected-record versions do not match the encrypted event.');
    }
    await this.repository.applySyncEvent(event, committed.sequence);
    outboxOperation = await this.updateOutboxOperation(outboxOperation, { state: 'applied' });
    if (state.partitionedSyncEnabled) {
      await this.repository.markPartitionHydrated(partitionKey, committed.sequence);
      await runtime.controlPlane.updatePartitionCursor({
        deviceId: state.deviceId,
        partitionKey,
        lastAppliedSequence: committed.sequence,
        hydratedAt: new Date(this.now()).toISOString(),
      });
    }
    await runtime.controlPlane.updateDeviceCursor({
      deviceId: state.deviceId,
      lastAppliedSequence: committed.sequence,
    });
    await this.repository.removeSyncOutboxOperation(outboxOperation.operationId);
    await this.compactSnapshotWithRuntime(runtime, false).catch(error => {
      console.warn('Automatic encrypted snapshot compaction failed:', error);
    });
    return event;
  }

  private async preparePayloadMedia(
    runtime: Awaited<ReturnType<EventSyncEngine['openRuntime']>>,
    recordType: SyncRecordType,
    payload: SyncPayload | null,
    preparedMedia: PreparedMediaUpload[],
  ): Promise<SyncPayload | null> {
    if (!payload) return null;
    if (recordType === 'diary') {
      const diary = payload as Diary;
      return {
        ...diary,
        coverImage: diary.coverImage
          ? await this.prepareMediaUri(runtime, diary.coverImage, preparedMedia, 'image')
          : undefined,
      };
    }
    if (recordType === 'profile') {
      const profile = payload as UserProfile;
      return {
        ...profile,
        avatarUri: profile.avatarUri
          ? await this.prepareMediaUri(runtime, profile.avatarUri, preparedMedia, 'image')
          : undefined,
      };
    }
    if (recordType === 'settings') return payload as AppSettings;
    if (recordType !== 'entry') return payload;
    const entry = payload as Entry;
    const photoUris: string[] = [];
    for (const uri of entry.photoUris) {
      photoUris.push(await this.prepareMediaUri(runtime, uri, preparedMedia, 'image'));
    }
    const blocks = [];
    for (const block of entry.blocks || []) {
      blocks.push({
        ...block,
        audioUri: block.audioUri ? await this.prepareMediaUri(runtime, block.audioUri, preparedMedia, 'audio') : undefined,
      });
    }
    return {
      ...entry,
      photoUris,
      audioUri: entry.audioUri ? await this.prepareMediaUri(runtime, entry.audioUri, preparedMedia, 'audio') : undefined,
      blocks: entry.blocks ? blocks : undefined,
    };
  }

  private async prepareMediaUri(
    runtime: Awaited<ReturnType<EventSyncEngine['openRuntime']>>,
    uri: string,
    preparedMedia: PreparedMediaUpload[],
    mediaKind?: PreparedMediaUpload['mediaKind'],
  ): Promise<string> {
    if (parseSyncMediaReference(uri)) return uri;
    const knownReference = this.localMediaReferences.get(uri);
    if (knownReference) return knownReference;

    const mediaId = crypto.randomUUID();
    const media = await readMediaUri(uri);
    const resolvedMediaKind = mediaKind || mediaKindFromMimeType(media.mimeType);
    const payload = encodeSyncMediaPayload(mediaId, media.mimeType, media.bytes);
    const state = await this.repository.getLocalSyncAccountState();
    if (!state) throw new Error('Encrypted account metadata is unavailable.');
    const activeKeyEpoch = runtime.state.keyEpoch || state.keyEpoch || 1;
    const activeRootKey = getAccountRootKeyForEpoch(runtime.secrets, activeKeyEpoch);
    const encrypted = await encryptSyncPayload(activeRootKey, 'media', payload, { keyEpoch: activeKeyEpoch });
    const file = await this.upload({
      session: runtime.googleSession,
      name: `/media/${mediaId}.ddmedia`,
      objectKind: 'media',
      bytes: encrypted.bytes,
      appProperties: { accountId: state.accountId, mediaId, mediaKind: resolvedMediaKind, mimeType: media.mimeType },
    });
    const thumbnail = await this.createThumbnail(media).catch(() => null);
    let encryptedThumbnail: { driveFileId: string; sha256: string; sizeBytes: number } | undefined;
    if (thumbnail) {
      const thumbnailPayload = encodeSyncThumbnailPayload(mediaId, thumbnail.mimeType, thumbnail.bytes);
      const thumbnailEncrypted = await encryptSyncPayload(activeRootKey, 'thumbnail', thumbnailPayload, { keyEpoch: activeKeyEpoch });
      const thumbnailFile = await this.upload({
        session: runtime.googleSession,
        name: `/thumbnails/${mediaId}.ddthumb`,
        objectKind: 'thumbnail',
        bytes: thumbnailEncrypted.bytes,
        appProperties: { accountId: state.accountId, mediaId, mediaKind: 'image', mimeType: thumbnail.mimeType, sourceDriveFileId: file.id },
      });
      encryptedThumbnail = {
        driveFileId: thumbnailFile.id,
        sha256: thumbnailEncrypted.sha256,
        sizeBytes: thumbnailEncrypted.bytes.byteLength,
      };
    }
    const reference = createStableSyncMediaReference(mediaId, file.id);
    preparedMedia.push({
      mediaId,
      localUri: uri,
      driveFileId: file.id,
      mediaKind: resolvedMediaKind,
      sha256: encrypted.sha256,
      sizeBytes: encrypted.bytes.byteLength,
      reference,
      thumbnail: encryptedThumbnail,
    });
    return reference;
  }

  private async resolveMediaReference(reference: string): Promise<string> {
    const parsed = parseSyncMediaReference(reference);
    if (!parsed) return reference;
    const cached = this.resolvedMediaReferences.get(reference);
    if (cached) return cached;
    let pointer = parsed.sequence
      ? await this.repository.getSyncMediaPointer(parsed.sequence)
      : (parsed.driveFileId
          ? await this.repository.getSyncMediaPointerByDriveFileId(parsed.driveFileId)
          : await this.repository.getSyncMediaPointerByMediaId(parsed.mediaId));
    if (!pointer && parsed.driveFileId) {
      pointer = await this.restoreMissingMediaPointer(parsed.mediaId, parsed.driveFileId);
    }
    if (!pointer) throw new Error('Synced media metadata is missing from this device.');
    if (!pointer.mediaId && parsed.mediaId) {
      await this.repository.saveSyncMediaPointer({ ...pointer, mediaId: parsed.mediaId });
      pointer.mediaId = parsed.mediaId;
    }
    if (pointer.localUri) {
      this.resolvedMediaReferences.set(reference, pointer.localUri);
      this.localMediaReferences.set(pointer.localUri, reference);
      return pointer.localUri;
    }

    const runtime = await this.openRuntime();
    const state = await this.repository.getLocalSyncAccountState();
    if (!state) throw new Error('Encrypted account metadata is unavailable.');
    const encrypted = await downloadVerifiedSyncObject(runtime.googleSession, {
      id: `media-${pointer.sequence}`,
      accountId: state.accountId,
      sequence: pointer.sequence,
      driveFileId: pointer.driveFileId,
      objectKind: 'media',
      sha256: pointer.sha256,
      sizeBytes: pointer.sizeBytes,
      createdByDeviceId: pointer.createdByDeviceId,
      createdAt: pointer.createdAt,
    }, this.download);
    const decrypted = await decryptSyncPayload(
      getAccountRootKeyForEpoch(runtime.secrets, pointer.keyEpoch || 1),
      encrypted,
    );
    if (decrypted.objectKind !== 'media') throw new Error('Synced media object metadata is invalid.');
    const media = decodeSyncMediaPayload(decrypted.payload);
    if (media.mediaId !== parsed.mediaId) throw new Error('Synced media reference does not match its payload.');
    const localUri = await cacheSyncMedia(media.mediaId, media.mimeType, media.bytes);
    await this.repository.saveSyncMediaPointer({ ...pointer, mediaId: media.mediaId, localUri });
    this.resolvedMediaReferences.set(reference, localUri);
    this.localMediaReferences.set(localUri, reference);
    return localUri;
  }

  private async restoreMissingMediaPointer(
    mediaId: string,
    driveFileId: string,
  ) {
    const runtime = await this.openRuntime();
    let afterSequence = 0;
    while (true) {
      const objects = await runtime.controlPlane.listSyncObjectsAfter(runtime.state.deviceId, afterSequence, 500);
      const mediaObject = objects.find(object => object.objectKind === 'media' && object.driveFileId === driveFileId);
      if (mediaObject) {
        const pointer = {
          mediaId,
          sequence: mediaObject.sequence,
          driveFileId: mediaObject.driveFileId,
          sha256: mediaObject.sha256,
          sizeBytes: mediaObject.sizeBytes,
          createdByDeviceId: mediaObject.createdByDeviceId,
          createdAt: mediaObject.createdAt,
          keyEpoch: mediaObject.keyEpoch || 1,
        };
        await this.repository.saveSyncMediaPointer(pointer);
        return pointer;
      }
      if (objects.length === 0 || objects.length < 500) break;
      afterSequence = Math.max(afterSequence, ...objects.map(object => object.sequence));
    }
    return this.restoreOrphanedDriveMediaPointer(runtime, mediaId, driveFileId);
  }

  private async restoreOrphanedDriveMediaPointer(
    runtime: Awaited<ReturnType<EventSyncEngine['openRuntime']>>,
    mediaId: string,
    driveFileId: string,
  ) {
    const encrypted = this.download
      ? await this.download(runtime.googleSession, driveFileId)
      : await downloadDriveSyncObject(runtime.googleSession, driveFileId);
    let keyEpoch = runtime.state.keyEpoch || 1;
    try {
      const envelope = JSON.parse(new TextDecoder().decode(encrypted)) as { header?: { keyEpoch?: number } };
      if (envelope.header?.keyEpoch) keyEpoch = envelope.header.keyEpoch;
    } catch {
      // Decryption below will report invalid encrypted payloads.
    }
    const candidateKeys = [
      runtime.secrets.accountRootKeys?.[keyEpoch],
      getAccountRootKeyForEpoch(runtime.secrets, keyEpoch),
      runtime.secrets.accountRootKey,
      ...Object.values(runtime.secrets.accountRootKeys || {}),
    ].filter(Boolean) as Uint8Array[];
    const uniqueKeys = candidateKeys.filter((key, index) => (
      candidateKeys.findIndex(candidate => candidate === key || candidate.toString() === key.toString()) === index
    ));
    for (const rootKey of uniqueKeys) {
      try {
        const decrypted = await decryptSyncPayload(rootKey, encrypted);
        if (decrypted.objectKind !== 'media') continue;
        const media = decodeSyncMediaPayload(decrypted.payload);
        if (media.mediaId !== mediaId) continue;
        const localUri = await cacheSyncMedia(media.mediaId, media.mimeType, media.bytes);
        const pointer = {
          mediaId,
          sequence: 0,
          driveFileId,
          sha256: await sha256Hex(encrypted),
          sizeBytes: encrypted.byteLength,
          createdByDeviceId: runtime.state.deviceId,
          createdAt: new Date(this.now()).toISOString(),
          localUri,
          keyEpoch,
        };
        await this.repository.saveSyncMediaPointer(pointer);
        return pointer;
      } catch {
        // Try the next known account root key.
      }
    }
    return null;
  }

  private async resolveMediaReferenceBestEffort(reference: string, label: string): Promise<string> {
    if (!parseSyncMediaReference(reference)) return reference;
    try {
      return await this.resolveMediaReference(reference);
    } catch (error) {
      console.warn(`Synced ${label} could not be restored yet:`, error);
      return reference;
    }
  }

  private async pullPendingUnlocked(): Promise<void> {
    this.requireOnline();
    const runtime = await this.openRuntime();
    await this.assertActiveDevice(runtime.controlPlane, runtime.state.deviceId);
    await this.pullWithRuntime(runtime);
    await this.compactSnapshotWithRuntime(runtime, false).catch(error => {
      console.warn('Automatic encrypted snapshot compaction failed:', error);
    });
    await this.runMaintenanceWithRuntime(runtime, false).catch(error => {
      console.warn('Encrypted sync maintenance will be retried:', error);
    });
  }

  private async compactSnapshotWithRuntime(
    runtime: Awaited<ReturnType<EventSyncEngine['openRuntime']>>,
    force: boolean,
  ): Promise<SyncObjectMetadata | null> {
    let state = await this.repository.getLocalSyncAccountState();
    if (!state || state.deviceRole !== 'primary_mobile') return null;
    const localSnapshotSequence = state.latestSnapshotSequence || 0;
    if (!force && state.currentSyncSequence - localSnapshotSequence < this.snapshotIntervalEvents) return null;

    const account = await runtime.controlPlane.lookupCurrentGoogleAccount();
    if (!account) throw new Error('Encrypted account metadata was not found.');
    if (!force && account.currentSyncSequence - account.currentSnapshotSequence < this.snapshotIntervalEvents) {
      if (account.currentSnapshotSequence > localSnapshotSequence) {
        await this.repository.saveLocalSyncAccountState({
          ...state,
          latestSnapshotSequence: account.currentSnapshotSequence,
        });
      }
      return null;
    }
    if (state.currentSyncSequence !== account.currentSyncSequence) {
      await this.pullWithRuntime(runtime);
      state = await this.repository.getLocalSyncAccountState();
      if (!state || state.currentSyncSequence !== account.currentSyncSequence) return null;
    }

    const payload = await exportRepositorySnapshotPayload(
      this.repository,
      state.accountId,
      state.currentSyncSequence,
    );
    const activeKeyEpoch = runtime.state.keyEpoch || state.keyEpoch || 1;
    const activeRootKey = getAccountRootKeyForEpoch(runtime.secrets, activeKeyEpoch);
    const encrypted = await encryptSyncPayload(activeRootKey, 'snapshot', payload, { keyEpoch: activeKeyEpoch });
    const expectedSequence = state.currentSyncSequence + 1;
    const file = await this.upload({
      session: runtime.googleSession,
      name: `/snapshots/${expectedSequence}.ddsnapshot`,
      objectKind: 'snapshot',
      bytes: encrypted.bytes,
      appProperties: {
        accountId: state.accountId,
        baseSequence: state.currentSyncSequence,
      },
    });
    const committed = await runtime.controlPlane.commitSyncObject({
      deviceId: state.deviceId,
      afterSequence: state.currentSyncSequence,
      driveFileId: file.id,
      objectKind: 'snapshot',
      sha256: encrypted.sha256,
      sizeBytes: encrypted.bytes.byteLength,
      keyEpoch: activeKeyEpoch,
    });
    await this.repository.saveLocalSyncAccountState({
      ...state,
      currentSyncSequence: committed.sequence,
      latestSnapshotSequence: committed.sequence,
      latestSnapshotDriveFileId: committed.driveFileId,
    });
    await runtime.controlPlane.updateDeviceCursor({
      deviceId: state.deviceId,
      lastAppliedSequence: committed.sequence,
    });
    await this.runMaintenanceWithRuntime(runtime, true).catch(error => {
      console.warn('Encrypted sync maintenance will be retried:', error);
    });
    return committed;
  }

  private async runMaintenanceWithRuntime(
    runtime: Awaited<ReturnType<EventSyncEngine['openRuntime']>>,
    force: boolean,
  ): Promise<void> {
    const state = await this.repository.getLocalSyncAccountState();
    if (!state || state.deviceRole !== 'primary_mobile') return;
    const now = this.now();
    if (!force && now - this.lastMaintenanceAt < this.maintenanceIntervalMs) return;
    const startedAt = this.now();
    try {
      const plan = await this.maintenance({
        controlPlane: runtime.controlPlane,
        primaryDeviceId: state.deviceId,
        googleSession: runtime.googleSession,
        now,
        liveDriveFileIds: collectLiveMediaDriveFileIds(await this.repository.exportSnapshot()),
      });
      emitSyncTelemetry('sync.maintenance.complete', {
        durationMs: this.now() - startedAt,
        objectsToRetire: plan.objectsToRetire.length,
        snapshotsToRetire: plan.snapshotsToRetire.length,
        eventsToRetire: plan.eventsToRetire.length,
        driveFilesToDelete: plan.driveFilesToDelete.length,
      });
    } catch (error: any) {
      emitSyncTelemetry('sync.maintenance.failed', {
        durationMs: this.now() - startedAt,
        error: error?.message || 'Encrypted sync maintenance failed.',
      }, 'warn');
      throw error;
    }
    this.lastMaintenanceAt = now;
  }

  private async hydrateArchivePartitionWithRuntime(
    runtime: Awaited<ReturnType<EventSyncEngine['openRuntime']>>,
    partitionKey: string,
  ): Promise<void> {
    const startedAt = this.now();
    emitSyncTelemetry('sync.archive.partition.start', { partitionKey });
    await this.repository.markPartitionHydrating(partitionKey);
    try {
      const result = await hydrateArchivePartitionFromCloud({
        repository: this.repository,
        controlPlane: runtime.controlPlane,
        localState: runtime.state,
        accountRootKey: runtime.secrets.accountRootKey,
        accountRootKeys: runtime.secrets.accountRootKeys,
        googleSession: runtime.googleSession,
        partitionKey,
        download: this.download,
        now: new Date(this.now()),
      });
      if (!result.hydratedPartitionKeys.includes(partitionKey)) {
        throw new Error('Archive partition is not available in the latest manifest.');
      }
      const hydrationState = await this.repository.getPartitionHydrationState(partitionKey);
      await runtime.controlPlane.updatePartitionCursor({
        deviceId: runtime.state.deviceId,
        partitionKey,
        lastAppliedSequence: hydrationState.lastAppliedSequence,
        hydratedAt: new Date(this.now()).toISOString(),
      });
      const currentState = await this.repository.getLocalSyncAccountState();
      if (currentState) {
        await runtime.controlPlane.updateDeviceCursor({
          deviceId: currentState.deviceId,
          lastAppliedSequence: Math.max(currentState.currentSyncSequence, result.currentSyncSequence),
        });
      }
      emitSyncTelemetry('sync.archive.partition.complete', {
        partitionKey,
        durationMs: this.now() - startedAt,
        currentSyncSequence: result.currentSyncSequence,
      });
    } catch (error: any) {
      await this.repository.markPartitionHydrationFailed(partitionKey, error?.message || 'Archive hydration failed.');
      const failedState = await this.repository.getPartitionHydrationState(partitionKey);
      emitSyncTelemetry('sync.archive.partition.failed', {
        partitionKey,
        durationMs: this.now() - startedAt,
        error: error?.message || 'Archive hydration failed.',
        failureCount: failedState.failureCount || 1,
        nextRetryAt: failedState.nextRetryAt,
      }, 'warn');
      throw error;
    }
  }

  private async pullWithRuntime(runtime: Awaited<ReturnType<EventSyncEngine['openRuntime']>>): Promise<void> {
    let state = (await this.repository.getLocalSyncAccountState()) || runtime.state;
    if (state.partitionedSyncEnabled) {
      await this.pullPartitionedWithRuntime(runtime);
      return;
    }
    while (true) {
      const objects = await runtime.controlPlane.listSyncObjectsAfter(state.deviceId, state.currentSyncSequence, 100);
      if (objects.length === 0) break;
      const processedKeyPackageSequence = await this.processKeyPackagesWithRuntime(runtime, objects);
      state = await replaySyncObjects({
        repository: this.repository,
        localState: state,
        accountRootKey: runtime.secrets.accountRootKey,
        accountRootKeys: runtime.secrets.accountRootKeys,
        googleSession: runtime.googleSession,
        objects: objects.filter(object => object.objectKind !== 'key_package'),
      });
      if (processedKeyPackageSequence > state.currentSyncSequence) {
        state = {
          ...state,
          currentSyncSequence: processedKeyPackageSequence,
        };
        await this.repository.saveLocalSyncAccountState(state);
      }
      if (objects.length < 100) break;
    }
    await runtime.controlPlane.updateDeviceCursor({
      deviceId: state.deviceId,
      lastAppliedSequence: state.currentSyncSequence,
    });
  }

  private async pullPartitionedWithRuntime(
    runtime: Awaited<ReturnType<EventSyncEngine['openRuntime']>>,
  ): Promise<void> {
    let state = (await this.repository.getLocalSyncAccountState()) || runtime.state;
    await this.pullGlobalKeyPackagesForPartitionedRuntime(runtime, state);
    state = (await this.repository.getLocalSyncAccountState()) || state;
    await this.registerRecentEventOnlyPartitions(runtime, state);
    const [coreState, archiveMonths] = await Promise.all([
      this.repository.getPartitionHydrationState('core'),
      this.repository.listAvailableArchiveMonths(),
    ]);
    const partitionStates = [coreState, ...archiveMonths]
      .filter(partition => partition.status === 'hydrated')
      .filter((partition, index, all) => (
        all.findIndex(candidate => candidate.partitionKey === partition.partitionKey) === index
      ));
    if (partitionStates.length === 0) {
      await runtime.controlPlane.updateDeviceCursor({
        deviceId: state.deviceId,
        lastAppliedSequence: state.currentSyncSequence,
      });
      return;
    }

    for (const partition of partitionStates) {
      let afterSequence = partition.lastAppliedSequence;
      while (true) {
        const objects = await runtime.controlPlane.listPartitionObjectsAfter(
          state.deviceId,
          partition.partitionKey,
          afterSequence,
          100,
        );
        if (objects.length === 0) break;
        const processedKeyPackageSequence = await this.processKeyPackagesWithRuntime(runtime, objects);
        state = await replaySyncObjects({
          repository: this.repository,
          localState: state,
          accountRootKey: runtime.secrets.accountRootKey,
          accountRootKeys: runtime.secrets.accountRootKeys,
          googleSession: runtime.googleSession,
          objects: objects.filter(object => object.objectKind !== 'key_package'),
          download: this.download,
          allowHistorical: true,
        });
        if (processedKeyPackageSequence > state.currentSyncSequence) {
          state = {
            ...state,
            currentSyncSequence: processedKeyPackageSequence,
          };
          await this.repository.saveLocalSyncAccountState(state);
        }
        afterSequence = Math.max(afterSequence, ...objects.map(object => object.sequence));
        if (objects.length < 100) break;
      }
      if (afterSequence > partition.lastAppliedSequence) {
        await this.repository.markPartitionHydrated(partition.partitionKey, afterSequence);
        await runtime.controlPlane.updatePartitionCursor({
          deviceId: state.deviceId,
          partitionKey: partition.partitionKey,
          lastAppliedSequence: afterSequence,
          hydratedAt: new Date(this.now()).toISOString(),
        });
      }
      state = (await this.repository.getLocalSyncAccountState()) || state;
    }

    await runtime.controlPlane.updateDeviceCursor({
      deviceId: state.deviceId,
      lastAppliedSequence: state.currentSyncSequence,
    });
  }

  private async registerRecentEventOnlyPartitions(
    runtime: Awaited<ReturnType<EventSyncEngine['openRuntime']>>,
    state: LocalSyncAccountState,
  ): Promise<void> {
    if (typeof runtime.controlPlane.listPartitionHeads !== 'function') return;

    const heads = await runtime.controlPlane.listPartitionHeads(state.deviceId);
    const recentKeys = new Set<string>(recentPartitionKeys(new Date(this.now())));
    const candidates = heads.filter(head => (
      recentKeys.has(head.partitionKey) &&
      head.latestEventSequence > 0 &&
      head.latestSnapshotSequence === 0
    ));
    if (candidates.length === 0) return;

    const localKeys = new Set<string>(listPartitionKeysInSnapshot(await this.repository.exportSnapshot()));
    for (const head of candidates) {
      const hydration = await this.repository.getPartitionHydrationState(head.partitionKey);
      if (hydration.status !== 'not_available') continue;

      // Older builds committed new-month events without recording the partition cursor.
      // Existing local records are already represented through the device's global cursor.
      const lastAppliedSequence = localKeys.has(head.partitionKey) ? state.currentSyncSequence : 0;
      await this.repository.markPartitionHydrated(head.partitionKey, lastAppliedSequence);
      await runtime.controlPlane.updatePartitionCursor({
        deviceId: state.deviceId,
        partitionKey: head.partitionKey,
        lastAppliedSequence,
        hydratedAt: new Date(this.now()).toISOString(),
      });
    }
  }

  private async processKeyPackagesWithRuntime(
    runtime: Awaited<ReturnType<EventSyncEngine['openRuntime']>>,
    objects: SyncObjectMetadata[],
  ): Promise<number> {
    const keyPackages = objects
      .filter(object => object.objectKind === 'key_package')
      .sort((left, right) => left.sequence - right.sequence);
    if (keyPackages.length === 0) return 0;

    const hasAccountEpochLookup = typeof runtime.controlPlane.lookupCurrentGoogleAccount === 'function';
    const account = hasAccountEpochLookup
      ? await runtime.controlPlane.lookupCurrentGoogleAccount().catch(() => null)
      : null;
    const currentAccountEpoch = hasAccountEpochLookup
      ? account?.currentKeyEpoch || runtime.state.keyEpoch || 1
      : Number.MAX_SAFE_INTEGER;
    let maxProcessedSequence = 0;
    for (const object of keyPackages) {
      if (object.accountId !== runtime.state.accountId) throw new Error('Sync metadata belongs to another account.');
      const objectEpoch = object.keyEpoch || 1;
      if (objectEpoch > currentAccountEpoch) {
        emitSyncTelemetry('sync.key_package.future_epoch_deferred', {
          sequence: object.sequence,
          keyEpoch: objectEpoch,
          currentAccountEpoch,
        }, 'warn');
        continue;
      }
      if (runtime.secrets.accountRootKeys?.[objectEpoch]) {
        maxProcessedSequence = Math.max(maxProcessedSequence, object.sequence);
        continue;
      }

      let decoded;
      try {
        const bytes = await downloadVerifiedSyncObject(runtime.googleSession, object, this.download);
        decoded = decodeCompanionKeyPackage(bytes);
      } catch (error) {
        emitSyncTelemetry('sync.key_package.read_failed', {
          sequence: object.sequence,
          keyEpoch: object.keyEpoch || 1,
        }, 'warn');
        console.warn('Encrypted key package could not be read and will be retried later:', error);
        continue;
      }

      const packageEpoch = decoded.keyEpoch || objectEpoch;
      if (packageEpoch !== objectEpoch) {
        emitSyncTelemetry('sync.key_package.epoch_mismatch', {
          sequence: object.sequence,
          objectEpoch,
          packageEpoch,
        }, 'warn');
        console.warn('Encrypted key package epoch did not match control-plane metadata.');
        continue;
      }
      if (decoded.accountId !== runtime.state.accountId) {
        emitSyncTelemetry('sync.key_package.account_mismatch', {
          sequence: object.sequence,
          keyEpoch: packageEpoch,
        }, 'warn');
        console.warn('Encrypted key package belongs to another account.');
        continue;
      }
      maxProcessedSequence = Math.max(maxProcessedSequence, object.sequence);

      let unwrappedKeys: {
        keyEpoch: number;
        accountRootKey: Uint8Array;
        accountRootKeys: Record<number, Uint8Array>;
      };
      try {
        unwrappedKeys = await unwrapRootKeysForCompanion(
          decoded,
          runtime.state.devicePublicKey,
          runtime.secrets.devicePrivateKeyJwk,
        );
      } catch (error: any) {
        if (String(error?.message || '').includes('targets another device')) continue;
        emitSyncTelemetry('sync.key_package.open_failed', {
          sequence: object.sequence,
          keyEpoch: packageEpoch,
          error: error?.message || 'Encrypted key package could not be opened.',
        }, 'warn');
        console.warn('Encrypted key package could not be opened and will be retried later:', error);
        continue;
      }

      const latestSecrets = (await this.loadSecrets()) || runtime.secrets;
      const previousEpoch = runtime.state.keyEpoch || 1;
      const updatedSecrets = withAccountRootKeyForEpoch({
        ...latestSecrets,
        accountRootKeys: {
          ...(latestSecrets.accountRootKeys || {}),
          [previousEpoch]: latestSecrets.accountRootKey,
          ...unwrappedKeys.accountRootKeys,
        },
      }, packageEpoch, unwrappedKeys.accountRootKeys[packageEpoch] || unwrappedKeys.accountRootKey);
      await this.saveSecrets(updatedSecrets);
      runtime.secrets = updatedSecrets;

      const currentState = (await this.repository.getLocalSyncAccountState()) || runtime.state;
      const updatedState = {
        ...currentState,
        keyEpoch: Math.max(currentState.keyEpoch || 1, packageEpoch),
      };
      await this.repository.saveLocalSyncAccountState(updatedState);
      runtime.state = updatedState;
      emitSyncTelemetry('sync.key_package.applied', {
        sequence: object.sequence,
        keyEpoch: packageEpoch,
      });
    }
    return maxProcessedSequence;
  }

  private async pullGlobalKeyPackagesForPartitionedRuntime(
    runtime: Awaited<ReturnType<EventSyncEngine['openRuntime']>>,
    state: LocalSyncAccountState,
  ): Promise<void> {
    if (typeof runtime.controlPlane.listSyncObjectsAfter !== 'function') return;
    let scanAfterSequence = state.currentSyncSequence;
    let maxProcessedSequence = 0;
    while (true) {
      const objects = await runtime.controlPlane.listSyncObjectsAfter(state.deviceId, scanAfterSequence, 100);
      if (objects.length === 0) break;
      maxProcessedSequence = Math.max(maxProcessedSequence, await this.processKeyPackagesWithRuntime(runtime, objects));
      scanAfterSequence = Math.max(scanAfterSequence, ...objects.map(object => object.sequence));
      if (objects.length < 100) break;
    }
    if (maxProcessedSequence > state.currentSyncSequence) {
      const currentState = (await this.repository.getLocalSyncAccountState()) || state;
      await this.repository.saveLocalSyncAccountState({
        ...currentState,
        currentSyncSequence: Math.max(currentState.currentSyncSequence, maxProcessedSequence),
      });
    }
  }

  private async openRuntime() {
    const state = await this.repository.getLocalSyncAccountState();
    if (!state) throw new Error('Create or recover your encrypted account before editing.');
    let secrets = await this.loadSecrets();
    if (!secrets || secrets.accountId !== state.accountId) {
      throw new Error('This device no longer has the encrypted account key. Recover the account to continue.');
    }
    const expiresAt = secrets.supabaseSession.expiresAt || 0;
    if (expiresAt <= Math.floor(this.now() / 1000) + 90) {
      if (!secrets.supabaseSession.refreshToken) {
        this.notifyAuthorizationRequired('Your encrypted sync session expired.');
        throw new Error('Your encrypted sync session expired. Sign in again.');
      }
      let supabaseSession;
      try {
        supabaseSession = await refreshSupabaseSession({
          supabaseUrl: getConfiguredSupabaseUrl(),
          anonKey: getConfiguredSupabaseAnonKey(),
          refreshToken: secrets.supabaseSession.refreshToken,
        });
      } catch (error) {
        this.notifyAuthorizationRequired('Your encrypted sync session expired.');
        throw error;
      }
      secrets = { ...secrets, supabaseSession };
      await this.saveSecrets(secrets);
      if (this.realtimeClient) await this.realtimeClient.realtime.setAuth(supabaseSession.accessToken);
    }
    if (!isNativePlatform()) {
      const webSession = await restoreWebGoogleSyncSession().catch(() => null);
      if (webSession?.googleSession.userId === state.googleUserId) {
        secrets = {
          ...secrets,
          googleSession: webSession.googleSession,
          supabaseSession: webSession.supabaseSession,
        };
        await this.saveSecrets(secrets);
        if (this.realtimeClient) await this.realtimeClient.realtime.setAuth(webSession.supabaseSession.accessToken);
      }
    }
    const googleSession = await this.restoreGoogleSession(secrets);
    if (!googleSession?.accessToken || googleSession.userId !== state.googleUserId) {
      this.notifyAuthorizationRequired('Google Drive authorization is required.');
      throw new Error('Google Drive authorization is required to sync this account.');
    }
    return {
      state,
      secrets,
      googleSession,
      controlPlane: this.createControlPlane(secrets.supabaseSession.accessToken),
    };
  }

  private async assertActiveDevice(controlPlane: SupabaseControlPlaneClient, deviceId: string): Promise<void> {
    const device = await controlPlane.getDeviceStatus(deviceId);
    if (!device || device.revokedAt || (device.activationState || 'active') !== 'active') {
      this.stopPolling();
      await clearSyncSecrets();
      await this.repository.clearLocalSyncAccountState();
      if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('deardiary-device-revoked'));
      throw new Error('This device is not active. Recover or pair it again.');
    }
  }

  private requireOnline(): void {
    if (!this.isOnline()) throw new Error('Dear Diary must be online to save synced changes.');
  }

  private notifyAuthorizationRequired(message: string): void {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('deardiary-sync-auth-required', { detail: { message } }));
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation).catch(error => {
      const message = error?.message || '';
      if (message.includes('authorization expired') || message.includes('session expired')) {
        this.notifyAuthorizationRequired(message);
      }
      throw error;
    });
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}
