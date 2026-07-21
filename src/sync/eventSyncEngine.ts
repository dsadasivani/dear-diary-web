import type { DiaryRepository, RepositorySnapshot } from '../repositories/DiaryRepository';
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import type {
  Diary,
  Entry,
  Note,
  AppSettings,
  GoogleAccountSession,
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
import {
  decryptSyncPayload,
  decryptSyncPayloadWithKnownKeys,
  encryptSyncPayload,
} from './encryptedSyncObject';
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
import { partitionKeyForRecordPayload } from './syncPartitioning';
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
import type { ArchiveHydrationPolicyInput } from './partitionHydrationPolicy';
import { emitSyncTelemetry } from './syncTelemetry';
import { getSyncRuntimeFlags } from './runtimeFlags';
import { SyncError } from './errors';
import { reportUnexpectedError } from '../infrastructure/telemetry/reportUnexpectedError';
import { sanitizeEntry, sanitizeNote } from '../domain/richTextSanitizer';
import { measureAsync } from '../utils/performance';
import { SyncHealthService } from './health/SyncHealthService';
import {
  ArchiveHydrationService,
  defaultArchiveHydrationPolicyInput,
  type BackgroundArchiveHydrationResult,
} from './ArchiveHydrationService';
import { RemotePullService } from './RemotePullService';
import {
  pendingOutboxV2FromLegacy,
  recoverDeletesBlockedByConflictedWrites,
  scheduleOutboxFailure,
  type OutboxRepository,
  type SyncOutboxOperationV2,
} from './outbox';
import { mapSupabaseError } from './errors';

export type { BackgroundArchiveHydrationResult } from './ArchiveHydrationService';

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
): SyncOutboxDriveObject[] =>
  preparedMedia.map((media) => ({
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

const preparedMediaFromOutbox = (
  objects: SyncOutboxDriveObject[] | undefined,
): PreparedMediaUpload[] =>
  (objects || [])
    .filter(
      (object) =>
        object.objectKind === 'media' && object.mediaId && object.localUri && object.reference,
    )
    .map((object) => ({
      mediaId: object.mediaId!,
      localUri: object.localUri!,
      driveFileId: object.driveFileId,
      mediaKind: 'file',
      sha256: object.sha256,
      sizeBytes: object.sizeBytes,
      reference: object.reference!,
      thumbnail: object.thumbnail,
    }));

type SyncThumbnailGenerator = (media: {
  bytes: Uint8Array;
  mimeType: string;
}) => Promise<{ bytes: Uint8Array; mimeType: string } | null>;

export interface EventSyncEngineDependencies {
  isOnline?: () => boolean;
  loadSecrets?: () => Promise<SyncSecrets | null>;
  saveSecrets?: (secrets: SyncSecrets) => Promise<void>;
  restoreGoogleSession?: (secrets: SyncSecrets) => Promise<GoogleAccountSession | null>;
  restoreGoogleSessionInteractively?: () => Promise<GoogleAccountSession | null>;
  startGoogleSyncAuth?: () => Promise<GoogleAccountSession>;
  createControlPlane?: (accessToken: string) => SupabaseControlPlaneClient;
  upload?: (input: UploadDriveSyncObjectInput) => Promise<{ id: string }>;
  download?: SyncObjectDownloader;
  now?: () => number;
  snapshotIntervalEvents?: number;
  maintenance?: typeof performSyncMaintenance;
  maintenanceIntervalMs?: number;
  getArchiveHydrationPolicyInput?: () =>
    ArchiveHydrationPolicyInput | Promise<ArchiveHydrationPolicyInput>;
  backgroundArchiveBatchSize?: number;
  createThumbnail?: SyncThumbnailGenerator;
  syncHealthService?: SyncHealthService;
  outboxRepository?: OutboxRepository;
  outboxWorkerId?: string;
  outboxLeaseDurationMs?: number;
}

export const DEFAULT_SNAPSHOT_INTERVAL_EVENTS = 100;
const OUTBOX_RETRY_BASE_MS = 30_000;
const OUTBOX_RETRY_MAX_MS = 30 * 60 * 1000;
const DEFAULT_OUTBOX_LEASE_DURATION_MS = 2 * 60 * 1000;

const nextOutboxRetryAt = (now: number, retryCount: number): number => {
  const delay = Math.min(
    OUTBOX_RETRY_MAX_MS,
    OUTBOX_RETRY_BASE_MS * 2 ** Math.min(Math.max(retryCount - 1, 0), 10),
  );
  return now + delay;
};

export const isAccountWideOutboxFailure = (error: unknown): boolean => {
  if (error instanceof SupabaseControlPlaneError)
    return error.status === 401 || error.status === 403;
  if (!(error instanceof SyncError)) return false;
  return new Set([
    'OFFLINE',
    'AUTH_EXPIRED',
    'AUTH_INVALID',
    'DEVICE_REVOKED',
    'PROTOCOL_INCOMPATIBLE',
    'SCHEMA_INCOMPATIBLE',
    'KEY_EPOCH_UNAVAILABLE',
    'LOCAL_DATABASE_FAILURE',
    'SERVER_UNAVAILABLE',
    'INVARIANT_VIOLATION',
  ]).has(error.code);
};

const timestampForDriveFile = (file: DriveSyncObjectSummary): number => {
  const timestamp = file.modifiedTime || file.createdTime;
  return timestamp ? Date.parse(timestamp) || 0 : 0;
};

const stableMediaIdForOutboxSlot = async (slot: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(slot));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

const findDriveObjectByAppProperties = async (
  session: GoogleAccountSession,
  objectKind: SyncObjectMetadata['objectKind'],
  matches: (appProperties: Record<string, string>) => boolean,
): Promise<DriveSyncObjectSummary | null> => {
  const files = await listDriveSyncObjects(session);
  return (
    files
      .filter(
        (file) => file.appProperties?.objectKind === objectKind && matches(file.appProperties),
      )
      .sort((left, right) => timestampForDriveFile(right) - timestampForDriveFile(left))[0] || null
  );
};

const mediaKindFromMimeType = (mimeType: string): PreparedMediaUpload['mediaKind'] => {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'file';
};

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

export const buildStorageBreakdown = (
  files: DriveSyncObjectSummary[],
  liveDriveFileIds?: Iterable<string>,
): DriveSyncStorageBreakdown => {
  const liveFiles = liveDriveFileIds ? new Set(liveDriveFileIds) : null;
  const legacyImageSourceIds = new Set(
    files
      .filter((file) => file.appProperties?.objectKind === 'thumbnail')
      .map((file) => file.appProperties?.sourceDriveFileId)
      .filter((fileId): fileId is string => Boolean(fileId)),
  );
  let imageBytes = 0;
  let audioBytes = 0;
  let journalDataBytes = 0;
  let pendingCleanupBytes = 0;
  files.forEach((file) => {
    const size = file.size || 0;
    const kind = file.appProperties?.mediaKind;
    const objectKind = file.appProperties?.objectKind;
    const isMediaObject = objectKind === 'media' || objectKind === 'thumbnail';
    if (liveFiles && isMediaObject && !liveFiles.has(file.id)) {
      pendingCleanupBytes += size;
      return;
    }
    if (kind === 'image' || objectKind === 'thumbnail' || legacyImageSourceIds.has(file.id)) {
      imageBytes += size;
    } else if (kind === 'audio' || objectKind === 'media') {
      audioBytes += size;
    } else {
      journalDataBytes += size;
    }
  });
  return { journalDataBytes, imageBytes, audioBytes, pendingCleanupBytes };
};

export interface DriveSyncStorageBreakdown {
  journalDataBytes: number;
  imageBytes: number;
  audioBytes: number;
  pendingCleanupBytes: number;
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
        ? pointers.find((pointer) => pointer.sequence === parsed.sequence)
        : pointers.find(
            (pointer) =>
              (!!parsed.driveFileId && pointer.driveFileId === parsed.driveFileId) ||
              (!!parsed.mediaId && pointer.mediaId === parsed.mediaId),
          ),
    );
  };

  snapshot.diaries.forEach((diary) => addReference(diary.coverImage));
  snapshot.entries.forEach((entry) => {
    entry.photoUris.forEach(addReference);
    addReference(entry.audioUri);
    (entry.blocks || []).forEach((block) => addReference(block.audioUri));
  });
  addReference(snapshot.userProfile?.avatarUri);
  return live;
};

const isUsableCachedMediaUri = (uri: string): boolean =>
  isNativePlatform() || uri.startsWith('data:') || uri.startsWith('blob:');

export class SyncConflictError extends Error {
  constructor(
    message: string,
    readonly recoveredRecordId?: string,
  ) {
    super(message);
    this.name = 'SyncConflictError';
  }
}

export interface SyncRuntimeDelegate {
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
  pullPending(): Promise<void>;
  flushPendingOutbox(): Promise<void>;
  requestOutboxFlush(delayMs?: number): void;
}

export class EventSyncEngine {
  private operationTail: Promise<void> = Promise.resolve();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private outboxFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private realtimeClient: SupabaseClient | null = null;
  private runtimeDelegate: SyncRuntimeDelegate | null = null;
  private realtimeChannel: RealtimeChannel | null = null;
  private readonly isOnline: () => boolean;
  private readonly loadSecrets: () => Promise<SyncSecrets | null>;
  private readonly saveSecrets: (secrets: SyncSecrets) => Promise<void>;
  private readonly restoreGoogleSession: (
    secrets: SyncSecrets,
  ) => Promise<GoogleAccountSession | null>;
  private readonly restoreGoogleSessionInteractively: () => Promise<GoogleAccountSession | null>;
  private readonly startGoogleSyncAuth: () => Promise<GoogleAccountSession>;
  private readonly createControlPlane: (accessToken: string) => SupabaseControlPlaneClient;
  private readonly upload: (input: UploadDriveSyncObjectInput) => Promise<{ id: string }>;
  private readonly download?: SyncObjectDownloader;
  private readonly now: () => number;
  private readonly snapshotIntervalEvents: number;
  private readonly maintenance: typeof performSyncMaintenance;
  private readonly maintenanceIntervalMs: number;
  private readonly createThumbnail: SyncThumbnailGenerator;
  private readonly syncHealthService: SyncHealthService;
  private readonly archiveHydrationService: ArchiveHydrationService;
  private readonly remotePullService: RemotePullService;
  private readonly outboxRepository?: OutboxRepository;
  private readonly outboxWorkerId: string;
  private readonly outboxLeaseDurationMs: number;
  private lastMaintenanceAt = 0;
  private readonly resolvedMediaReferences = new Map<string, string>();
  private readonly localMediaReferences = new Map<string, string>();

  constructor(
    private readonly repository: DiaryRepository,
    dependencies: EventSyncEngineDependencies = {},
  ) {
    this.isOnline =
      dependencies.isOnline || (() => typeof navigator === 'undefined' || navigator.onLine);
    this.loadSecrets = dependencies.loadSecrets || (() => loadSyncSecrets());
    this.saveSecrets = dependencies.saveSecrets || ((secrets) => saveSyncSecrets(secrets));
    this.restoreGoogleSession =
      dependencies.restoreGoogleSession ||
      ((secrets) =>
        isNativePlatform()
          ? restoreGoogleDriveSession(false)
          : Promise.resolve(secrets.googleSession || null));
    this.restoreGoogleSessionInteractively =
      dependencies.restoreGoogleSessionInteractively || (() => restoreGoogleDriveSession(true));
    this.startGoogleSyncAuth = dependencies.startGoogleSyncAuth || (() => startGoogleAuth('sync'));
    this.createControlPlane =
      dependencies.createControlPlane ||
      ((accessToken) =>
        new SupabaseControlPlaneClient({
          url: getConfiguredSupabaseUrl(),
          anonKey: getConfiguredSupabaseAnonKey(),
          accessToken,
        }));
    this.upload = dependencies.upload || uploadDriveSyncObject;
    this.download = dependencies.download;
    this.now = dependencies.now || Date.now;
    this.snapshotIntervalEvents =
      dependencies.snapshotIntervalEvents || DEFAULT_SNAPSHOT_INTERVAL_EVENTS;
    this.maintenance = dependencies.maintenance || performSyncMaintenance;
    this.maintenanceIntervalMs = dependencies.maintenanceIntervalMs || 24 * 60 * 60 * 1000;
    this.createThumbnail = dependencies.createThumbnail || createImageThumbnail;
    this.outboxRepository = dependencies.outboxRepository;
    this.outboxWorkerId =
      dependencies.outboxWorkerId ||
      `sync-worker:${crypto.randomUUID?.() || Math.random().toString(36).slice(2)}`;
    this.outboxLeaseDurationMs =
      dependencies.outboxLeaseDurationMs || DEFAULT_OUTBOX_LEASE_DURATION_MS;
    this.syncHealthService =
      dependencies.syncHealthService || new SyncHealthService(repository, this.now);
    this.archiveHydrationService = new ArchiveHydrationService(repository, {
      download: this.download,
      now: this.now,
      getArchiveHydrationPolicyInput:
        dependencies.getArchiveHydrationPolicyInput ||
        (() => defaultArchiveHydrationPolicyInput(this.isOnline)),
      backgroundArchiveBatchSize: dependencies.backgroundArchiveBatchSize,
    });
    this.remotePullService = new RemotePullService(repository, {
      download: this.download,
      now: this.now,
      loadSecrets: this.loadSecrets,
      saveSecrets: this.saveSecrets,
    });
  }

  commitMutation(
    recordType: SyncRecordType,
    operation: SyncEventOperation,
    recordId: string,
    payload: SyncPayload | null,
  ): Promise<SyncDomainEvent> {
    if (!getSyncRuntimeFlags().syncWritesEnabled) {
      return Promise.reject(new SyncError({ code: 'DEPENDENCY_BLOCKED', retryable: true }));
    }
    return this.enqueue(() =>
      measureAsync(
        'sync.commitMutation',
        () => this.commitMutationUnlocked(recordType, operation, recordId, payload),
        {
          recordType,
          operation,
          hasPayload: Boolean(payload),
        },
      ),
    );
  }

  installRuntimeDelegate(delegate: SyncRuntimeDelegate | null): void {
    if (this.runtimeDelegate === delegate) return;
    if (this.runtimeDelegate) void this.runtimeDelegate.stop();
    this.stopLegacyPolling();
    this.runtimeDelegate = delegate;
  }

  pullPending(): Promise<void> {
    if (this.runtimeDelegate) return this.runtimeDelegate.pullPending();
    if (!getSyncRuntimeFlags().remotePullEnabled) return Promise.resolve();
    return this.enqueue(() =>
      this.syncHealthService.track('PULL', () =>
        measureAsync('sync.pullPending', () => this.pullPendingUnlocked()),
      ),
    );
  }

  requestOutboxFlush(delayMs = 0): void {
    if (this.runtimeDelegate) {
      this.runtimeDelegate.requestOutboxFlush(delayMs);
      return;
    }
    if (this.outboxFlushTimer) return;
    this.outboxFlushTimer = setTimeout(() => {
      this.outboxFlushTimer = null;
      void this.flushPendingOutbox().catch((error) => {
        reportUnexpectedError('sync.outbox.background_flush', error);
      });
    }, delayMs);
  }

  flushPendingOutbox(): Promise<void> {
    if (this.runtimeDelegate) return this.runtimeDelegate.flushPendingOutbox();
    if (!getSyncRuntimeFlags().syncWritesEnabled) return Promise.resolve();
    return this.enqueue(() =>
      this.syncHealthService.track('PUSH', () =>
        measureAsync('sync.outbox.flush', () => this.flushPendingOutboxUnlocked()),
      ),
    );
  }

  createSnapshot(): Promise<SyncObjectMetadata | null> {
    if (!getSyncRuntimeFlags().snapshotCreationEnabled) return Promise.resolve(null);
    return this.enqueue(async () => {
      this.requireOnline();
      const runtime = await this.openRuntime();
      await this.assertActiveDevice(runtime.controlPlane, runtime.state.deviceId);
      await this.pullWithRuntime(runtime);
      const state = await this.repository.getLocalSyncAccountState();
      if (state?.partitionedSyncEnabled) {
        return this.compactPartitionedRestorePointWithRuntime(runtime, true);
      }
      return this.compactSnapshotWithRuntime(runtime, true);
    });
  }

  getDriveSyncStatus(): Promise<DriveSyncStatus> {
    return this.enqueue(async () => {
      this.requireOnline();
      const runtime = await this.openRuntime();
      let liveMediaDriveFileIds: Set<string> | undefined;
      if (runtime.state.deviceRole === 'primary_mobile') {
        liveMediaDriveFileIds = collectLiveMediaDriveFileIds(
          await this.repository.exportSnapshot(),
        );
        await this.runMaintenanceWithRuntime(runtime, true, liveMediaDriveFileIds).catch(
          (error) => {
            console.warn('Encrypted sync cleanup before storage status failed:', error);
          },
        );
      }
      const [files, storageQuota] = await Promise.all([
        listDriveSyncObjects(runtime.googleSession),
        getDriveStorageQuota(runtime.googleSession).catch(() => null),
      ]);
      const latestFile = [...files].sort(
        (left, right) => timestampForDriveFile(right) - timestampForDriveFile(left),
      )[0];

      return {
        accountEmail: runtime.state.googleEmail,
        appStorageBytes: files.reduce((sum, file) => sum + (file.size || 0), 0),
        storageQuota,
        storageBreakdown: buildStorageBreakdown(files, liveMediaDriveFileIds),
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
      if (runtime.state.partitionedSyncEnabled && runtime.state.latestManifestDriveFileId)
        return false;
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
      if (!current) throw new SyncError({ code: 'LOCAL_DATABASE_FAILURE', safetyRelevant: true });
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
      await this.archiveHydrationService.hydratePartition(runtime, partitionKey);
    });
  }

  hydrateBackgroundArchiveOnce(): Promise<BackgroundArchiveHydrationResult> {
    if (!getSyncRuntimeFlags().archiveHydrationEnabled) {
      return Promise.resolve({
        decision: { allowed: false, reason: 'disabled_by_runtime_flag' },
        hydratedPartitionKeys: [],
      });
    }
    return this.enqueue(async () => {
      return this.archiveHydrationService.hydrateBackgroundArchiveOnce({
        requireOnline: () => this.requireOnline(),
        openRuntime: () => this.openRuntime(),
        assertActiveDevice: (controlPlane, deviceId) =>
          this.assertActiveDevice(controlPlane, deviceId),
      });
    });
  }

  async reauthorize(): Promise<void> {
    if (!isNativePlatform()) {
      await startWebGoogleSyncSignIn();
      return;
    }
    const state = await this.repository.getLocalSyncAccountState();
    const secrets = await this.loadSecrets();
    if (!state || !secrets) throw new SyncError({ code: 'AUTH_INVALID', userActionRequired: true });

    // The native Drive bridge already stores the exact linked account. Renew its Drive grant
    // first so reconnect does not depend on Credential Manager opening an account chooser.
    // A full Google sign-in remains the fallback when the Supabase session also needs a new ID token.
    const restoredSession =
      (await this.restoreGoogleSession(secrets).catch(() => null)) ||
      (await this.restoreGoogleSessionInteractively().catch(() => null));
    if (restoredSession?.accessToken && restoredSession.userId === state.googleUserId) {
      let supabaseSession = secrets.supabaseSession;
      const expiresSoon = (supabaseSession.expiresAt || 0) <= Math.floor(this.now() / 1000) + 90;
      if (expiresSoon && supabaseSession.refreshToken) {
        supabaseSession = await refreshSupabaseSession({
          supabaseUrl: getConfiguredSupabaseUrl(),
          anonKey: getConfiguredSupabaseAnonKey(),
          refreshToken: supabaseSession.refreshToken,
        }).catch(() => supabaseSession);
      }
      const sessionIsUsable = (supabaseSession.expiresAt || 0) > Math.floor(this.now() / 1000) + 90;
      if (sessionIsUsable) {
        await this.saveSecrets({
          ...secrets,
          googleSession: {
            ...restoredSession,
            idToken: restoredSession.idToken || secrets.googleSession?.idToken || null,
          },
          supabaseSession,
        });
        return;
      }
    }

    const googleSession = await this.startGoogleSyncAuth();
    if (googleSession.userId !== state.googleUserId || !googleSession.idToken) {
      throw new SyncError({ code: 'AUTH_INVALID', userActionRequired: true });
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
    return {
      ...diary,
      coverImage: await this.resolveMediaReferenceBestEffort(diary.coverImage!, 'diary cover'),
    };
  }

  hydrateDiaries(diaries: Diary[]): Promise<Diary[]> {
    return Promise.all(diaries.map((diary) => this.hydrateDiary(diary)));
  }

  async hydrateEntries(entries: Entry[]): Promise<Entry[]> {
    const needsMedia = entries.some(
      (entry) =>
        entry.photoUris.some((uri) => Boolean(parseSyncMediaReference(uri))) ||
        Boolean(parseSyncMediaReference(entry.audioUri)) ||
        entry.blocks?.some((block) => Boolean(parseSyncMediaReference(block.audioUri))),
    );
    if (!needsMedia) return entries;
    return Promise.all(
      entries.map(async (entry) => ({
        ...entry,
        photoUris: await Promise.all(
          entry.photoUris.map((uri) => this.resolveMediaReferenceBestEffort(uri, 'entry photo')),
        ),
        audioUri: entry.audioUri
          ? await this.resolveMediaReferenceBestEffort(entry.audioUri, 'entry audio')
          : undefined,
        blocks: entry.blocks
          ? await Promise.all(
              entry.blocks.map(async (block) => ({
                ...block,
                audioUri: block.audioUri
                  ? await this.resolveMediaReferenceBestEffort(block.audioUri, 'entry block audio')
                  : undefined,
              })),
            )
          : undefined,
      })),
    );
  }

  async hydrateProfile(profile: UserProfile): Promise<UserProfile> {
    if (!parseSyncMediaReference(profile.avatarUri)) return profile;
    return {
      ...profile,
      avatarUri: await this.resolveMediaReferenceBestEffort(profile.avatarUri!, 'profile avatar'),
    };
  }

  hydrateMediaReference(reference: string, label = 'media'): Promise<string> {
    return this.resolveMediaReferenceBestEffort(reference, label);
  }

  startPolling(intervalMs = 90_000): void {
    if (this.runtimeDelegate) {
      void this.runtimeDelegate.start();
      return;
    }
    if (this.pollTimer) return;
    void this.pullPending().catch((error) =>
      console.warn('Initial encrypted sync pull failed:', error),
    );
    void this.ensurePartitionedSync().catch((error) =>
      console.warn('Partitioned sync migration will be retried:', error),
    );
    void this.hydrateBackgroundArchiveOnce().catch((error) =>
      console.warn('Background archive hydration will be retried:', error),
    );
    void this.startRealtime().catch((error) =>
      console.warn('Supabase Realtime sync could not start:', error),
    );
    this.pollTimer = setInterval(() => {
      if (!this.isOnline()) return;
      void (async () => {
        await this.pullPending();
        await this.hydrateBackgroundArchiveOnce();
      })().catch((error) => console.warn('Encrypted sync pull failed:', error));
    }, intervalMs);
  }

  stopPolling(): void {
    if (this.runtimeDelegate) {
      void this.runtimeDelegate.stop();
      return;
    }
    this.stopLegacyPolling();
  }

  private stopLegacyPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.realtimeClient && this.realtimeChannel) {
      void this.realtimeClient.removeChannel(this.realtimeChannel);
    }
    this.realtimeChannel = null;
    this.realtimeClient = null;
  }

  private async startRealtime(): Promise<void> {
    if (!getSyncRuntimeFlags().realtimeEnabled) return;
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
          void this.pullPending().catch((error) =>
            console.warn('Realtime encrypted sync pull failed:', error),
          );
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
    if (!state) throw new SyncError({ code: 'AUTH_INVALID', userActionRequired: true });
    const baseRecordVersion = await this.repository.getSyncRecordVersion(recordType, recordId);
    const affectedRecords =
      recordType === 'diary' && operation === 'delete'
        ? await Promise.all(
            (await this.repository.listEntries())
              .filter((entry) => entry.diaryId === recordId)
              .map(async (entry) => ({
                recordType: 'entry' as const,
                recordId: entry.id,
                baseRecordVersion: await this.repository.getSyncRecordVersion('entry', entry.id),
              })),
          )
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
        (error.providerCode === 'stale_sync_sequence' ||
          error.providerCode === 'stale_record_version')
      ) {
        await this.repository.removeSyncOutboxOperation(operationId).catch(() => undefined);
        await this.pullWithRuntime(runtime);
        if (
          operation === 'upsert' &&
          originalPayload &&
          (recordType === 'entry' || recordType === 'note')
        ) {
          const recoveredId = `${recordType}-recovered-${crypto.randomUUID()}`;
          const recoveredPayload =
            recordType === 'entry'
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
          await this.commitMutationUnlocked(
            recordType,
            'upsert',
            recoveredId,
            sanitizeSyncPayload(recordType, recoveredPayload as SyncPayload) as SyncPayload,
          );
          throw new SyncConflictError(
            `This ${recordType} changed on another device. Your pending version was saved as a recovered copy.`,
            recoveredId,
          );
        }
        throw new SyncConflictError(
          'This record changed on another device. The latest version is now loaded.',
        );
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
    if (this.outboxRepository) {
      await this.resumeLeasedUserWriteOutbox(runtime);
      return;
    }
    const operations = await this.repository
      .listSyncOutboxOperations([
        'prepared',
        'media_uploading',
        'media_uploaded',
        'event_uploading',
        'event_uploaded',
        'metadata_committing',
        'committed',
        'applied',
        'failed',
      ])
      .then((items) => items.sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0)));
    await measureAsync(
      'sync.outbox.resume',
      async () => {
        for (const operation of operations) {
          const allOperations = await this.repository.listSyncOutboxOperations();
          const latest = allOperations.find(
            (candidate) => candidate.operationId === operation.operationId,
          );
          if (!latest || !latest.operation || latest.state === 'conflict_preserved') continue;
          if (latest.state === 'failed' && latest.nextRetryAt && latest.nextRetryAt > this.now()) {
            continue;
          }
          const dependency = latest.dependsOnOperationId
            ? allOperations.find(
                (candidate) => candidate.operationId === latest.dependsOnOperationId,
              )
            : null;
          if (dependency) continue;
          const readyOperation =
            latest.dependsOnOperationId && latest.baseRecordVersion === undefined
              ? await this.updateOutboxOperation(latest, {
                  baseRecordVersion: await this.repository.getSyncRecordVersion(
                    latest.recordType,
                    latest.recordId,
                  ),
                  dependsOnOperationId: undefined,
                })
              : latest;
          try {
            await this.executeUserWriteOutboxOperation(runtime, readyOperation);
          } catch (error: any) {
            if (
              readyOperation.localApplied &&
              error instanceof SupabaseControlPlaneError &&
              (error.providerCode === 'stale_sync_sequence' ||
                error.providerCode === 'stale_record_version')
            ) {
              await this.preserveLocalFirstConflict(runtime, readyOperation, error);
              continue;
            }
            if (isAccountWideOutboxFailure(error)) throw error;
            await this.markOutboxOperationFailed(
              readyOperation.operationId,
              error?.message || 'Encrypted sync write failed.',
            ).catch(() => undefined);
          }
        }
      },
      { operationCount: operations.length },
    );
  }

  private async preserveLocalFirstConflict(
    runtime: Awaited<ReturnType<EventSyncEngine['openRuntime']>>,
    operation: SyncOutboxOperation,
    error: SupabaseControlPlaneError,
  ): Promise<void> {
    const latestOperation =
      (await this.repository.listSyncOutboxOperations()).find(
        (candidate) => candidate.operationId === operation.operationId,
      ) || operation;
    let preservedOperation = await this.updateOutboxOperation(latestOperation, {
      state: 'conflict_preserved',
      error: error.message || 'Remote version conflict.',
      retryCount: (latestOperation.retryCount || 0) + 1,
      lastErrorAt: this.now(),
      nextRetryAt: undefined,
    });
    await this.pullWithRuntime(runtime);
    if (
      preservedOperation.operation !== 'upsert' ||
      !preservedOperation.payload ||
      !['entry', 'note'].includes(preservedOperation.recordType)
    ) {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('deardiary-sync-conflict', {
            detail: {
              message: 'This record changed on another device. The latest version is now loaded.',
            },
          }),
        );
      }
      return;
    }

    const recoveredId = `${preservedOperation.recordType}-recovered-${crypto.randomUUID()}`;
    const recoveredPayload =
      preservedOperation.recordType === 'entry'
        ? (sanitizeSyncPayload('entry', {
            ...(preservedOperation.payload as Entry),
            id: recoveredId,
            title: `${(preservedOperation.payload as Entry).title || 'Untitled entry'} (Recovered copy)`,
            createdAt: this.now(),
            updatedAt: this.now(),
          }) as Entry)
        : (sanitizeSyncPayload('note', {
            ...(preservedOperation.payload as Note),
            id: recoveredId,
            title: `${(preservedOperation.payload as Note).title || 'Untitled note'} (Recovered copy)`,
            createdAt: this.now(),
            updatedAt: this.now(),
          }) as Note);
    const account = await this.repository.getLocalSyncAccountState();
    if (!account) throw new SyncError({ code: 'LOCAL_DATABASE_FAILURE', safetyRelevant: true });
    await this.repository.applyLocalMutationWithOutbox({
      operationId: crypto.randomUUID(),
      recordType: latestOperation.recordType,
      recordId: recoveredId,
      operation: 'upsert',
      account,
      localPayload: recoveredPayload,
    });
    preservedOperation = await this.updateOutboxOperation(preservedOperation, {
      recoveredRecordId: recoveredId,
    });
    this.requestOutboxFlush(1_000);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('deardiary-sync-conflict', {
          detail: {
            message: `This ${preservedOperation.recordType} changed on another device. Your pending version was saved as a recovered copy.`,
            recoveredRecordId: recoveredId,
          },
        }),
      );
    }
  }

  private async markOutboxOperationFailed(operationId: string, error: string): Promise<void> {
    const latest = (await this.repository.listSyncOutboxOperations()).find(
      (operation) => operation.operationId === operationId,
    );
    if (!latest) return;
    const retryCount = (latest.retryCount || 0) + 1;
    await this.updateOutboxOperation(latest, {
      state: 'failed',
      error,
      retryCount,
      lastErrorAt: this.now(),
      nextRetryAt: nextOutboxRetryAt(this.now(), retryCount),
    });
  }

  private async executeUserWriteOutboxOperation(
    runtime: Awaited<ReturnType<EventSyncEngine['openRuntime']>>,
    persistedOperation: SyncOutboxOperation,
    affectedRecordsOverride?: Array<{
      recordType: 'entry';
      recordId: string;
      baseRecordVersion: number;
    }>,
  ): Promise<SyncDomainEvent> {
    return measureAsync(
      'sync.outbox.operation',
      () =>
        this.executeUserWriteOutboxOperationUnlocked(
          runtime,
          persistedOperation,
          affectedRecordsOverride,
        ),
      {
        recordType: persistedOperation.recordType,
        operation: persistedOperation.operation,
        state: persistedOperation.state,
        localApplied: Boolean(persistedOperation.localApplied),
      },
    );
  }

  private async executeUserWriteOutboxOperationUnlocked(
    runtime: Awaited<ReturnType<EventSyncEngine['openRuntime']>>,
    persistedOperation: SyncOutboxOperation,
    affectedRecordsOverride?: Array<{
      recordType: 'entry';
      recordId: string;
      baseRecordVersion: number;
    }>,
  ): Promise<SyncDomainEvent> {
    let outboxOperation = persistedOperation;
    if (outboxOperation.error) {
      outboxOperation = await this.updateOutboxOperation(outboxOperation, {
        error: undefined,
        nextRetryAt: undefined,
      });
    }
    const operation = outboxOperation.operation;
    if (!operation) throw new Error('Sync outbox operation is missing its mutation type.');
    let payload = sanitizeSyncPayload(
      outboxOperation.recordType,
      outboxOperation.payload as SyncPayload | null,
    );
    const state = await this.repository.getLocalSyncAccountState();
    if (!state) throw new SyncError({ code: 'AUTH_INVALID', userActionRequired: true });
    const baseRecordVersion =
      outboxOperation.baseRecordVersion ??
      (await this.repository.getSyncRecordVersion(
        outboxOperation.recordType,
        outboxOperation.recordId,
      ));
    const affectedRecords = affectedRecordsOverride || outboxOperation.affectedRecords || [];
    let partitionKey =
      outboxOperation.partitionKey ||
      partitionKeyForRecordPayload(outboxOperation.recordType, payload);
    let preparedMedia = preparedMediaFromOutbox(outboxOperation.uploadedObjects);
    const mayHaveUploadedMedia = persistedOperation.state === 'media_uploading';
    const mayHaveUploadedEvent = persistedOperation.state === 'event_uploading';

    if (
      !outboxOperation.uploadedObjects ||
      outboxOperation.state === 'prepared' ||
      outboxOperation.state === 'media_uploading'
    ) {
      outboxOperation = await this.updateOutboxOperation(outboxOperation, {
        state: 'media_uploading',
        error: undefined,
      });
      preparedMedia = [];
      payload = await measureAsync(
        'sync.media.preparePayload',
        () =>
          this.preparePayloadMedia(
            runtime,
            outboxOperation.recordType,
            payload,
            preparedMedia,
            outboxOperation.operationId,
            mayHaveUploadedMedia,
          ),
        {
          recordType: outboxOperation.recordType,
          operation: outboxOperation.operation,
        },
      );
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
    const preparedObjectCount = preparedMedia.reduce(
      (total, media) => total + 1 + (media.thumbnail ? 1 : 0),
      0,
    );
    const expectedSequence = state.currentSyncSequence + preparedObjectCount + 1;
    const eventFolder = partitionKey.startsWith('month:')
      ? partitionKey.slice('month:'.length)
      : 'core';
    if (
      !outboxOperation.eventDriveFileId ||
      !outboxOperation.eventSha256 ||
      !outboxOperation.eventSizeBytes
    ) {
      outboxOperation = await this.updateOutboxOperation(outboxOperation, {
        state: 'event_uploading',
      });
      encrypted = await encryptSyncPayload(activeRootKey, 'event', encodeSyncDomainEvent(event), {
        keyEpoch: activeKeyEpoch,
      });
      const existingFile = mayHaveUploadedEvent
        ? await findDriveObjectByAppProperties(
            runtime.googleSession,
            'event',
            (appProperties) =>
              appProperties.accountId === state.accountId &&
              (appProperties.operationId === event.eventId ||
                appProperties.eventId === event.eventId),
          ).catch(() => null)
        : null;
      let file = existingFile ? { id: existingFile.id } : null;
      if (existingFile) {
        const existingBytes = this.download
          ? await this.download(runtime.googleSession, existingFile.id)
          : await downloadDriveSyncObject(runtime.googleSession, existingFile.id);
        encrypted = { bytes: existingBytes, sha256: await sha256Hex(existingBytes) };
      } else {
        file = await this.upload({
          session: runtime.googleSession,
          name: `/events/${eventFolder}/${expectedSequence}-${event.eventId}.ddevent`,
          objectKind: 'event',
          bytes: encrypted.bytes,
          appProperties: {
            accountId: state.accountId,
            eventId: event.eventId,
            operationId: event.eventId,
            recordType: outboxOperation.recordType,
            recordId: outboxOperation.recordId,
            baseRecordVersion,
            partitionKey,
            keyEpoch: activeKeyEpoch,
          },
        });
      }
      outboxOperation = await this.updateOutboxOperation(outboxOperation, {
        state: 'event_uploaded',
        eventDriveFileId: file!.id,
        eventSha256: encrypted.sha256,
        eventSizeBytes: encrypted.bytes.byteLength,
      });
    }

    let committedObjects = outboxOperation.committedObjects || [];
    if (committedObjects.length === 0) {
      outboxOperation = await this.updateOutboxOperation(outboxOperation, {
        state: 'metadata_committing',
      });
      committedObjects =
        preparedMedia.length > 0
          ? await runtime.controlPlane.commitSyncBatch({
              deviceId: state.deviceId,
              operationId: event.eventId,
              objects: [
                ...preparedMedia.flatMap((media) => [
                  {
                    driveFileId: media.driveFileId,
                    objectKind: 'media' as const,
                    sha256: media.sha256,
                    sizeBytes: media.sizeBytes,
                    partitionKey,
                  },
                  ...(media.thumbnail
                    ? [
                        {
                          driveFileId: media.thumbnail.driveFileId,
                          objectKind: 'thumbnail' as const,
                          sha256: media.thumbnail.sha256,
                          sizeBytes: media.thumbnail.sizeBytes,
                          partitionKey,
                        },
                      ]
                    : []),
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
          : [
              await runtime.controlPlane.commitSyncObject({
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
              }),
            ];
      outboxOperation = await this.updateOutboxOperation(outboxOperation, {
        state: 'committed',
        committedObjects,
      });
    }

    const committed = committedObjects.find((object) => object.objectKind === 'event');
    if (!committed) throw new Error('Committed sync batch did not include the encrypted event.');
    for (const media of preparedMedia) {
      const mediaObject = committedObjects.find(
        (object) => object.objectKind === 'media' && object.driveFileId === media.driveFileId,
      );
      if (!mediaObject)
        throw new Error('Committed sync batch did not include an encrypted media object.');
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
            ? committedObjects.find(
                (object) =>
                  object.objectKind === 'thumbnail' &&
                  object.driveFileId === media.thumbnail?.driveFileId,
              )
            : null;
          return thumbnailObject
            ? {
                thumbnailSequence: thumbnailObject.sequence,
                thumbnailDriveFileId: thumbnailObject.driveFileId,
                thumbnailSha256: thumbnailObject.sha256,
                thumbnailSizeBytes: thumbnailObject.sizeBytes,
              }
            : {};
        })(),
      });
      this.localMediaReferences.set(media.localUri, media.reference);
      this.resolvedMediaReferences.set(media.reference, media.localUri);
    }
    if (committed.recordVersion !== event.recordVersion) {
      throw new Error('The committed record version does not match the encrypted event.');
    }
    if (
      JSON.stringify(committed.affectedRecords || []) !==
      JSON.stringify(event.affectedRecords || [])
    ) {
      throw new Error('Committed affected-record versions do not match the encrypted event.');
    }
    if (outboxOperation.localApplied) {
      await this.repository.acknowledgeLocalMutation({ event, sequence: committed.sequence });
    } else {
      await this.repository.applySyncEvent(event, committed.sequence);
    }
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
    void this.compactSnapshotWithRuntime(runtime, false).catch((error) => {
      console.warn('Automatic encrypted snapshot compaction failed:', error);
    });
    return event;
  }

  private async preparePayloadMedia(
    runtime: Awaited<ReturnType<EventSyncEngine['openRuntime']>>,
    recordType: SyncRecordType,
    payload: SyncPayload | null,
    preparedMedia: PreparedMediaUpload[],
    operationId: string,
    reuseUploadedDriveObjects: boolean,
  ): Promise<SyncPayload | null> {
    if (!payload) return null;
    if (recordType === 'diary') {
      const diary = payload as Diary;
      return {
        ...diary,
        coverImage: diary.coverImage
          ? await this.prepareMediaUri(
              runtime,
              diary.coverImage,
              preparedMedia,
              'image',
              `${operationId}:diary:cover`,
              reuseUploadedDriveObjects,
            )
          : undefined,
      };
    }
    if (recordType === 'profile') {
      const profile = payload as UserProfile;
      return {
        ...profile,
        avatarUri: profile.avatarUri
          ? await this.prepareMediaUri(
              runtime,
              profile.avatarUri,
              preparedMedia,
              'image',
              `${operationId}:profile:avatar`,
              reuseUploadedDriveObjects,
            )
          : undefined,
      };
    }
    if (recordType === 'settings') return payload as AppSettings;
    if (recordType !== 'entry') return payload;
    const entry = payload as Entry;
    const photoUris: string[] = [];
    for (const [index, uri] of entry.photoUris.entries()) {
      photoUris.push(
        await this.prepareMediaUri(
          runtime,
          uri,
          preparedMedia,
          'image',
          `${operationId}:entry:photo:${index}`,
          reuseUploadedDriveObjects,
        ),
      );
    }
    const blocks = [];
    for (const [index, block] of (entry.blocks || []).entries()) {
      blocks.push({
        ...block,
        audioUri: block.audioUri
          ? await this.prepareMediaUri(
              runtime,
              block.audioUri,
              preparedMedia,
              'audio',
              `${operationId}:entry:block-audio:${block.id || index}`,
              reuseUploadedDriveObjects,
            )
          : undefined,
      });
    }
    return {
      ...entry,
      photoUris,
      audioUri: entry.audioUri
        ? await this.prepareMediaUri(
            runtime,
            entry.audioUri,
            preparedMedia,
            'audio',
            `${operationId}:entry:audio`,
            reuseUploadedDriveObjects,
          )
        : undefined,
      blocks: entry.blocks ? blocks : undefined,
    };
  }

  private async prepareMediaUri(
    runtime: Awaited<ReturnType<EventSyncEngine['openRuntime']>>,
    uri: string,
    preparedMedia: PreparedMediaUpload[],
    mediaKind?: PreparedMediaUpload['mediaKind'],
    mediaSlot?: string,
    reuseUploadedDriveObjects = false,
  ): Promise<string> {
    return measureAsync(
      'sync.media.prepareUri',
      () =>
        this.prepareMediaUriUnlocked(
          runtime,
          uri,
          preparedMedia,
          mediaKind,
          mediaSlot,
          reuseUploadedDriveObjects,
        ),
      {
        mediaKind: mediaKind || 'unknown',
        reusableUpload: reuseUploadedDriveObjects,
        hasStableReference: Boolean(parseSyncMediaReference(uri)),
      },
    );
  }

  private async prepareMediaUriUnlocked(
    runtime: Awaited<ReturnType<EventSyncEngine['openRuntime']>>,
    uri: string,
    preparedMedia: PreparedMediaUpload[],
    mediaKind?: PreparedMediaUpload['mediaKind'],
    mediaSlot?: string,
    reuseUploadedDriveObjects = false,
  ): Promise<string> {
    if (parseSyncMediaReference(uri)) return uri;
    const knownReference = this.localMediaReferences.get(uri);
    if (knownReference) return knownReference;

    const mediaId = mediaSlot ? await stableMediaIdForOutboxSlot(mediaSlot) : crypto.randomUUID();
    const media = await readMediaUri(uri);
    const resolvedMediaKind = mediaKind || mediaKindFromMimeType(media.mimeType);
    const payload = encodeSyncMediaPayload(mediaId, media.mimeType, media.bytes);
    const state = await this.repository.getLocalSyncAccountState();
    if (!state) throw new SyncError({ code: 'LOCAL_DATABASE_FAILURE', safetyRelevant: true });
    const activeKeyEpoch = runtime.state.keyEpoch || state.keyEpoch || 1;
    const activeRootKey = getAccountRootKeyForEpoch(runtime.secrets, activeKeyEpoch);
    let encrypted: { bytes: Uint8Array; sha256: string } = await encryptSyncPayload(
      activeRootKey,
      'media',
      payload,
      { keyEpoch: activeKeyEpoch },
    );
    const existingMediaFile = reuseUploadedDriveObjects
      ? await findDriveObjectByAppProperties(
          runtime.googleSession,
          'media',
          (appProperties) =>
            appProperties.accountId === state.accountId && appProperties.mediaId === mediaId,
        ).catch(() => null)
      : null;
    let file = existingMediaFile ? { id: existingMediaFile.id } : null;
    if (existingMediaFile) {
      const existingBytes = this.download
        ? await this.download(runtime.googleSession, existingMediaFile.id)
        : await downloadDriveSyncObject(runtime.googleSession, existingMediaFile.id);
      encrypted = { bytes: existingBytes, sha256: await sha256Hex(existingBytes) };
    } else {
      file = await this.upload({
        session: runtime.googleSession,
        name: `/media/${mediaId}.ddmedia`,
        objectKind: 'media',
        bytes: encrypted.bytes,
        appProperties: {
          accountId: state.accountId,
          mediaId,
          mediaKind: resolvedMediaKind,
          mimeType: media.mimeType,
          mediaSlot,
        },
      });
    }
    let encryptedThumbnail: { driveFileId: string; sha256: string; sizeBytes: number } | undefined;
    const existingThumbnailFile = reuseUploadedDriveObjects
      ? await findDriveObjectByAppProperties(
          runtime.googleSession,
          'thumbnail',
          (appProperties) =>
            appProperties.accountId === state.accountId && appProperties.mediaId === mediaId,
        ).catch(() => null)
      : null;
    if (existingThumbnailFile) {
      const existingThumbnailBytes = this.download
        ? await this.download(runtime.googleSession, existingThumbnailFile.id)
        : await downloadDriveSyncObject(runtime.googleSession, existingThumbnailFile.id);
      encryptedThumbnail = {
        driveFileId: existingThumbnailFile.id,
        sha256: await sha256Hex(existingThumbnailBytes),
        sizeBytes: existingThumbnailBytes.byteLength,
      };
    } else {
      const thumbnail = await this.createThumbnail(media).catch(() => null);
      if (thumbnail) {
        const thumbnailPayload = encodeSyncThumbnailPayload(
          mediaId,
          thumbnail.mimeType,
          thumbnail.bytes,
        );
        const thumbnailEncrypted = await encryptSyncPayload(
          activeRootKey,
          'thumbnail',
          thumbnailPayload,
          { keyEpoch: activeKeyEpoch },
        );
        const thumbnailFile = await this.upload({
          session: runtime.googleSession,
          name: `/thumbnails/${mediaId}.ddthumb`,
          objectKind: 'thumbnail',
          bytes: thumbnailEncrypted.bytes,
          appProperties: {
            accountId: state.accountId,
            mediaId,
            mediaKind: 'image',
            mimeType: thumbnail.mimeType,
            sourceDriveFileId: file!.id,
            mediaSlot,
          },
        });
        encryptedThumbnail = {
          driveFileId: thumbnailFile.id,
          sha256: thumbnailEncrypted.sha256,
          sizeBytes: thumbnailEncrypted.bytes.byteLength,
        };
      }
    }
    const reference = createStableSyncMediaReference(mediaId, file!.id);
    preparedMedia.push({
      mediaId,
      localUri: uri,
      driveFileId: file!.id,
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
      : parsed.driveFileId
        ? await this.repository.getSyncMediaPointerByDriveFileId(parsed.driveFileId)
        : await this.repository.getSyncMediaPointerByMediaId(parsed.mediaId);
    if (!pointer && parsed.driveFileId) {
      pointer = await this.restoreMissingMediaPointer(parsed.mediaId, parsed.driveFileId);
    }
    if (!pointer) throw new Error('Synced media metadata is missing from this device.');
    if (!pointer.mediaId && parsed.mediaId) {
      await this.repository.saveSyncMediaPointer({ ...pointer, mediaId: parsed.mediaId });
      pointer.mediaId = parsed.mediaId;
    }
    if (pointer.localUri && isUsableCachedMediaUri(pointer.localUri)) {
      this.resolvedMediaReferences.set(reference, pointer.localUri);
      this.localMediaReferences.set(pointer.localUri, reference);
      return pointer.localUri;
    }
    if (pointer.localUri) {
      pointer = { ...pointer, localUri: undefined };
      await this.repository.saveSyncMediaPointer(pointer);
    }

    const runtime = await this.openRuntime();
    const state = await this.repository.getLocalSyncAccountState();
    if (!state) throw new SyncError({ code: 'LOCAL_DATABASE_FAILURE', safetyRelevant: true });
    const encrypted = await downloadVerifiedSyncObject(
      runtime.googleSession,
      {
        id: `media-${pointer.sequence}`,
        accountId: state.accountId,
        sequence: pointer.sequence,
        driveFileId: pointer.driveFileId,
        objectKind: 'media',
        sha256: pointer.sha256,
        sizeBytes: pointer.sizeBytes,
        createdByDeviceId: pointer.createdByDeviceId,
        createdAt: pointer.createdAt,
      },
      this.download,
    );
    const decrypted = await decryptSyncPayloadWithKnownKeys(
      encrypted,
      getAccountRootKeyForEpoch(runtime.secrets, pointer.keyEpoch || 1),
      runtime.secrets.accountRootKeys,
      pointer.keyEpoch,
    );
    if (decrypted.objectKind !== 'media')
      throw new Error('Synced media object metadata is invalid.');
    const media = decodeSyncMediaPayload(decrypted.payload);
    if (media.mediaId !== parsed.mediaId)
      throw new Error('Synced media reference does not match its payload.');
    const localUri = await cacheSyncMedia(media.mediaId, media.mimeType, media.bytes);
    await this.repository.saveSyncMediaPointer({ ...pointer, mediaId: media.mediaId, localUri });
    this.resolvedMediaReferences.set(reference, localUri);
    this.localMediaReferences.set(localUri, reference);
    return localUri;
  }

  private async restoreMissingMediaPointer(mediaId: string, driveFileId: string) {
    const runtime = await this.openRuntime();
    let afterSequence = 0;
    while (true) {
      const objects = await runtime.controlPlane.listSyncObjectsAfter(
        runtime.state.deviceId,
        afterSequence,
        500,
      );
      const mediaObject = objects.find(
        (object) => object.objectKind === 'media' && object.driveFileId === driveFileId,
      );
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
      afterSequence = Math.max(afterSequence, ...objects.map((object) => object.sequence));
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
      const envelope = JSON.parse(new TextDecoder().decode(encrypted)) as {
        header?: { keyEpoch?: number };
      };
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
    const uniqueKeys = candidateKeys.filter(
      (key, index) =>
        candidateKeys.findIndex(
          (candidate) => candidate === key || candidate.toString() === key.toString(),
        ) === index,
    );
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
    await this.resumeUserWriteOutbox(runtime);
    await this.pullWithRuntime(runtime);
    await this.compactSnapshotWithRuntime(runtime, false).catch((error) => {
      console.warn('Automatic encrypted snapshot compaction failed:', error);
    });
    await this.runMaintenanceWithRuntime(runtime, false).catch((error) => {
      console.warn('Encrypted sync maintenance will be retried:', error);
    });
  }

  private async flushPendingOutboxUnlocked(): Promise<void> {
    if (!this.isOnline()) {
      emitSyncTelemetry('sync.outbox.flush.skipped', { reason: 'offline' });
      return;
    }
    const runtime = await this.openRuntime();
    await this.assertActiveDevice(runtime.controlPlane, runtime.state.deviceId);
    await this.resumeUserWriteOutbox(runtime);
    await this.pullWithRuntime(runtime);
  }

  private async compactPartitionedRestorePointWithRuntime(
    runtime: Awaited<ReturnType<EventSyncEngine['openRuntime']>>,
    force: boolean,
  ): Promise<SyncObjectMetadata | null> {
    const state = await this.repository.getLocalSyncAccountState();
    if (!force || !state || state.deviceRole !== 'primary_mobile' || !state.partitionedSyncEnabled)
      return null;

    const activeKeyEpoch = runtime.state.keyEpoch || state.keyEpoch || 1;
    const activeRootKey = getAccountRootKeyForEpoch(runtime.secrets, activeKeyEpoch);
    const refreshId =
      crypto.randomUUID?.() || `${this.now()}-${Math.random().toString(36).slice(2)}`;
    const result = await migrateLocalAccountToPartitionedSync({
      repository: this.repository,
      controlPlane: runtime.controlPlane,
      localState: { ...state, keyEpoch: activeKeyEpoch },
      accountRootKey: activeRootKey,
      googleSession: runtime.googleSession,
      upload: this.upload,
      now: new Date(this.now()),
      operationIdPrefix: `partition-refresh:${state.accountId}:${activeKeyEpoch}:${refreshId}`,
    });

    await runtime.controlPlane.updateDeviceCursor({
      deviceId: state.deviceId,
      lastAppliedSequence: result.manifestObject.sequence,
    });
    await this.runMaintenanceWithRuntime(runtime, true).catch((error) => {
      console.warn('Encrypted sync maintenance will be retried:', error);
    });
    return result.manifestObject;
  }

  private async compactSnapshotWithRuntime(
    runtime: Awaited<ReturnType<EventSyncEngine['openRuntime']>>,
    force: boolean,
  ): Promise<SyncObjectMetadata | null> {
    let state = await this.repository.getLocalSyncAccountState();
    if (!state || state.deviceRole !== 'primary_mobile') return null;
    const localSnapshotSequence = state.latestSnapshotSequence || 0;
    if (!force && state.currentSyncSequence - localSnapshotSequence < this.snapshotIntervalEvents)
      return null;

    const account = await runtime.controlPlane.lookupCurrentGoogleAccount();
    if (!account) throw new SyncError({ code: 'LOCAL_DATABASE_FAILURE', safetyRelevant: true });
    if (
      !force &&
      account.currentSyncSequence - account.currentSnapshotSequence < this.snapshotIntervalEvents
    ) {
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
    const encrypted = await encryptSyncPayload(activeRootKey, 'snapshot', payload, {
      keyEpoch: activeKeyEpoch,
    });
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
    await this.runMaintenanceWithRuntime(runtime, true).catch((error) => {
      console.warn('Encrypted sync maintenance will be retried:', error);
    });
    return committed;
  }

  private async runMaintenanceWithRuntime(
    runtime: Awaited<ReturnType<EventSyncEngine['openRuntime']>>,
    force: boolean,
    liveDriveFileIds?: Iterable<string>,
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
        liveDriveFileIds:
          liveDriveFileIds || collectLiveMediaDriveFileIds(await this.repository.exportSnapshot()),
      });
      emitSyncTelemetry('sync.maintenance.complete', {
        durationMs: this.now() - startedAt,
        objectsToRetire: plan.objectsToRetire.length,
        snapshotsToRetire: plan.snapshotsToRetire.length,
        eventsToRetire: plan.eventsToRetire.length,
        driveFilesToDelete: plan.driveFilesToDelete.length,
      });
    } catch (error: any) {
      emitSyncTelemetry(
        'sync.maintenance.failed',
        {
          durationMs: this.now() - startedAt,
          error: error?.message || 'Encrypted sync maintenance failed.',
        },
        'warn',
      );
      throw error;
    }
    this.lastMaintenanceAt = now;
  }

  private async pullWithRuntime(
    runtime: Awaited<ReturnType<EventSyncEngine['openRuntime']>>,
  ): Promise<void> {
    return this.remotePullService.pull(runtime);
  }

  private async resumeLeasedUserWriteOutbox(
    runtime: Awaited<ReturnType<EventSyncEngine['openRuntime']>>,
  ): Promise<void> {
    const outboxRepository = this.outboxRepository!;
    await this.mirrorLegacyOutboxOperations(runtime.state.accountId, outboxRepository);
    await recoverDeletesBlockedByConflictedWrites({
      accountId: runtime.state.accountId,
      repository: this.repository,
      outbox: outboxRepository,
      pullLatest: () => this.pullWithRuntime(runtime),
    });
    while (true) {
      let claimed = await outboxRepository.claimNextRunnable({
        accountId: runtime.state.accountId,
        workerId: this.outboxWorkerId,
        now: this.now(),
        leaseDurationMs: this.outboxLeaseDurationMs,
      });
      if (!claimed) return;

      const legacyOperations = await this.repository.listSyncOutboxOperations();
      const legacyOperation = legacyOperations.find(
        (operation) => operation.operationId === claimed!.operationId,
      );
      if (
        !legacyOperation ||
        !legacyOperation.operation ||
        legacyOperation.state === 'conflict_preserved'
      ) {
        await this.transitionClaimedOutboxToSafetyStop(outboxRepository, claimed);
        continue;
      }

      claimed = await this.transitionClaimedOutboxToPreparing(outboxRepository, claimed);
      try {
        await this.withOutboxLeaseHeartbeat(outboxRepository, claimed, () =>
          this.executeUserWriteOutboxOperation(runtime, legacyOperation),
        );
        await this.acknowledgeClaimedOutbox(outboxRepository, claimed);
      } catch (error) {
        const latest = await outboxRepository.getById(claimed.operationId);
        if (latest?.leaseOwner === this.outboxWorkerId && latest.state === 'PREPARING') {
          if (
            legacyOperation.localApplied &&
            error instanceof SupabaseControlPlaneError &&
            (error.providerCode === 'stale_sync_sequence' ||
              error.providerCode === 'stale_record_version')
          ) {
            await this.preserveLocalFirstConflict(runtime, legacyOperation, error);
          } else if (!isAccountWideOutboxFailure(error)) {
            await this.markOutboxOperationFailed(
              legacyOperation.operationId,
              error instanceof Error ? error.message : 'Encrypted sync write failed.',
            ).catch(() => undefined);
          }
          const syncError = mapSupabaseError(error);
          const failure = scheduleOutboxFailure(latest, syncError, this.now());
          await outboxRepository.transition(
            latest.operationId,
            'PREPARING',
            failure.state,
            failure,
            this.outboxWorkerId,
          );
        }
        if (isAccountWideOutboxFailure(error)) throw error;
      }
    }
  }

  private async mirrorLegacyOutboxOperations(
    accountId: string,
    outboxRepository: OutboxRepository,
  ): Promise<void> {
    const legacyOperations = await this.repository.listSyncOutboxOperations([
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
    const legacyIds = new Set(legacyOperations.map((operation) => operation.operationId));
    for (const operation of legacyOperations) {
      if (
        operation.accountId !== accountId ||
        (await outboxRepository.getById(operation.operationId))
      )
        continue;
      const migratable =
        operation.dependsOnOperationId && !legacyIds.has(operation.dependsOnOperationId)
          ? { ...operation, dependsOnOperationId: undefined }
          : operation;
      await outboxRepository.enqueue(pendingOutboxV2FromLegacy(migratable));
    }
  }

  private transitionClaimedOutboxToPreparing(
    outboxRepository: OutboxRepository,
    operation: SyncOutboxOperationV2,
  ): Promise<SyncOutboxOperationV2> {
    if (operation.state === 'PREPARING') return Promise.resolve(operation);
    if (operation.state !== 'PENDING' && operation.state !== 'RETRY_WAIT') {
      throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
    }
    return outboxRepository.transition(
      operation.operationId,
      operation.state,
      'PREPARING',
      { nextAttemptAt: this.now() },
      this.outboxWorkerId,
    );
  }

  private async acknowledgeClaimedOutbox(
    outboxRepository: OutboxRepository,
    operation: SyncOutboxOperationV2,
  ): Promise<void> {
    const transitions: Array<[SyncOutboxOperationV2['state'], SyncOutboxOperationV2['state']]> = [
      ['PREPARING', 'READY_TO_COMMIT'],
      ['READY_TO_COMMIT', 'COMMITTING'],
      ['COMMITTING', 'COMMITTED'],
      ['COMMITTED', 'ACKNOWLEDGED'],
    ];
    let current = operation;
    for (const [expected, next] of transitions) {
      current = await outboxRepository.transition(
        current.operationId,
        expected,
        next,
        next === 'ACKNOWLEDGED' ? { leaseOwner: undefined, leaseExpiresAt: undefined } : {},
        this.outboxWorkerId,
      );
    }
  }

  private transitionClaimedOutboxToSafetyStop(
    outboxRepository: OutboxRepository,
    operation: SyncOutboxOperationV2,
  ): Promise<SyncOutboxOperationV2> {
    return outboxRepository.transition(
      operation.operationId,
      operation.state,
      'SAFETY_STOP',
      {
        lastErrorCode: 'INVARIANT_VIOLATION',
        lastErrorAt: this.now(),
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
      },
      this.outboxWorkerId,
    );
  }

  private async withOutboxLeaseHeartbeat<T>(
    outboxRepository: OutboxRepository,
    operation: SyncOutboxOperationV2,
    work: () => Promise<T>,
  ): Promise<T> {
    const heartbeatMs = Math.max(1_000, Math.floor(this.outboxLeaseDurationMs / 3));
    const timer = setInterval(() => {
      void outboxRepository
        .renewLease(
          operation.operationId,
          this.outboxWorkerId,
          this.now() + this.outboxLeaseDurationMs,
        )
        .catch((error) => reportUnexpectedError('sync.outbox.lease_renewal', error));
    }, heartbeatMs);
    try {
      return await work();
    } finally {
      clearInterval(timer);
    }
  }

  private async openRuntime() {
    const state = await this.repository.getLocalSyncAccountState();
    if (!state) throw new SyncError({ code: 'AUTH_INVALID', userActionRequired: true });
    let secrets = await this.loadSecrets();
    if (!secrets || secrets.accountId !== state.accountId) {
      throw new SyncError({
        code: 'KEY_EPOCH_UNAVAILABLE',
        userActionRequired: true,
        safetyRelevant: true,
      });
    }
    const expiresAt = secrets.supabaseSession.expiresAt || 0;
    if (expiresAt <= Math.floor(this.now() / 1000) + 90) {
      if (!secrets.supabaseSession.refreshToken) {
        this.notifyAuthorizationRequired('Your encrypted sync session expired.');
        throw new SyncError({ code: 'AUTH_EXPIRED', userActionRequired: true });
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
        throw new SyncError({ code: 'AUTH_EXPIRED', userActionRequired: true, cause: error });
      }
      secrets = { ...secrets, supabaseSession };
      await this.saveSecrets(secrets);
      if (this.realtimeClient)
        await this.realtimeClient.realtime.setAuth(supabaseSession.accessToken);
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
        if (this.realtimeClient)
          await this.realtimeClient.realtime.setAuth(webSession.supabaseSession.accessToken);
      }
    }
    const googleSession = await this.restoreGoogleSession(secrets);
    if (!googleSession?.accessToken || googleSession.userId !== state.googleUserId) {
      this.notifyAuthorizationRequired('Google Drive authorization is required.');
      throw new SyncError({ code: 'AUTH_EXPIRED', userActionRequired: true });
    }
    const controlPlane = this.createControlPlane(secrets.supabaseSession.accessToken);
    let runtimeState = state;
    if (
      state.deviceRole === 'primary_mobile' &&
      typeof controlPlane.lookupCurrentGoogleAccount === 'function'
    ) {
      const account = await controlPlane.lookupCurrentGoogleAccount().catch(() => null);
      const accountEpoch = account?.currentKeyEpoch || state.keyEpoch || 1;
      if (accountEpoch > (state.keyEpoch || 1)) {
        const epochRootKey = secrets.accountRootKeys?.[accountEpoch];
        if (!epochRootKey) {
          throw new SyncError({
            code: 'KEY_EPOCH_UNAVAILABLE',
            userActionRequired: true,
            safetyRelevant: true,
          });
        }
        secrets = withAccountRootKeyForEpoch(secrets, accountEpoch, epochRootKey);
        await this.saveSecrets(secrets);
        runtimeState = {
          ...state,
          keyEpoch: accountEpoch,
        };
        await this.repository.saveLocalSyncAccountState(runtimeState);
      }
    }
    return {
      state: runtimeState,
      secrets,
      googleSession,
      controlPlane,
    };
  }

  private async assertActiveDevice(
    controlPlane: SupabaseControlPlaneClient,
    deviceId: string,
  ): Promise<void> {
    const device = await controlPlane.getDeviceStatus(deviceId);
    if (!device || device.revokedAt || (device.activationState || 'active') !== 'active') {
      this.stopPolling();
      await clearSyncSecrets();
      await this.repository.clearLocalSyncAccountState();
      if (typeof window !== 'undefined')
        window.dispatchEvent(new CustomEvent('deardiary-device-revoked'));
      throw new SyncError({
        code: 'DEVICE_REVOKED',
        userActionRequired: true,
        safetyRelevant: true,
      });
    }
  }

  private requireOnline(): void {
    if (!this.isOnline()) throw new SyncError({ code: 'OFFLINE', retryable: true });
  }

  private notifyAuthorizationRequired(message: string): void {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('deardiary-sync-auth-required', { detail: { message } }),
      );
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation).catch((error) => {
      if (
        error instanceof SyncError &&
        (error.code === 'AUTH_EXPIRED' || error.code === 'AUTH_INVALID')
      ) {
        this.notifyAuthorizationRequired(error.message);
      }
      throw error;
    });
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
