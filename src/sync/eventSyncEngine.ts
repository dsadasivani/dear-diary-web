import type { DiaryRepository } from '../repositories/DiaryRepository';
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import type {
  Diary,
  Entry,
  AppSettings,
  GoogleAccountSession,
  SyncDomainEvent,
  SyncEventOperation,
  SyncObjectMetadata,
  SyncRecordType,
  UserProfile,
} from '../types';
import { restoreGoogleDriveSession, startGoogleAuth } from '../utils/googleAuth';
import { isNativePlatform } from '../platform';
import { getConfiguredSupabaseAnonKey, getConfiguredSupabaseUrl } from './config';
import { createSyncDomainEvent, encodeSyncDomainEvent } from './domainEvents';
import { uploadDriveSyncObject, type UploadDriveSyncObjectInput } from './driveSyncObjects';
import { decryptSyncPayload, encryptSyncPayload } from './encryptedSyncObject';
import { replaySyncObjects } from './eventReplay';
import { refreshSupabaseSession } from './supabaseAuth';
import { exchangeGoogleIdTokenForSupabaseSession } from './supabaseAuth';
import { SupabaseControlPlaneClient, SupabaseControlPlaneError } from './supabaseControlPlane';
import { clearSyncSecrets, loadSyncSecrets, saveSyncSecrets, type SyncSecrets } from './syncSecrets';
import { exportRepositorySnapshotPayload } from './syncSnapshot';
import {
  cacheSyncMedia,
  createSyncMediaReference,
  decodeSyncMediaPayload,
  encodeSyncMediaPayload,
  parseSyncMediaReference,
  readMediaUri,
} from './syncMedia';
import { downloadVerifiedSyncObject, type SyncObjectDownloader } from './eventReplay';
import { startWebGoogleSyncSignIn } from './webGoogleAuth';
import { performSyncMaintenance } from './syncMaintenance';

type SyncPayload = NonNullable<SyncDomainEvent['payload']>;

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
}

export const DEFAULT_SNAPSHOT_INTERVAL_EVENTS = 100;

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
    return { ...diary, coverImage: await this.resolveMediaReference(diary.coverImage!) };
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
      photoUris: await Promise.all(entry.photoUris.map(uri => this.resolveMediaReference(uri))),
      audioUri: entry.audioUri ? await this.resolveMediaReference(entry.audioUri) : undefined,
      blocks: entry.blocks ? await Promise.all(entry.blocks.map(async block => ({
        ...block,
        audioUri: block.audioUri ? await this.resolveMediaReference(block.audioUri) : undefined,
      }))) : undefined,
    })));
  }

  async hydrateProfile(profile: UserProfile): Promise<UserProfile> {
    if (!parseSyncMediaReference(profile.avatarUri)) return profile;
    return { ...profile, avatarUri: await this.resolveMediaReference(profile.avatarUri!) };
  }

  startPolling(intervalMs = 15_000): void {
    if (this.pollTimer) return;
    void this.pullPending().catch(error => console.warn('Initial encrypted sync pull failed:', error));
    void this.startRealtime().catch(error => console.warn('Supabase Realtime sync could not start:', error));
    this.pollTimer = setInterval(() => {
      if (!this.isOnline()) return;
      void this.pullPending().catch(error => console.warn('Encrypted sync pull failed:', error));
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
    await this.pullWithRuntime(runtime);

    payload = await this.preparePayloadMedia(runtime, recordType, payload);

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
    const event = createSyncDomainEvent({
      accountId: state.accountId,
      deviceId: state.deviceId,
      recordType,
      operation,
      recordId,
      baseRecordVersion,
      payload,
      affectedRecords,
    });
    const encrypted = await encryptSyncPayload(runtime.secrets.accountRootKey, 'event', encodeSyncDomainEvent(event));
    const expectedSequence = state.currentSyncSequence + 1;
    const file = await this.upload({
      session: runtime.googleSession,
      name: `/events/${expectedSequence}-${event.eventId}.ddevent`,
      objectKind: 'event',
      bytes: encrypted.bytes,
      appProperties: {
        accountId: state.accountId,
        eventId: event.eventId,
        recordType,
        recordId,
        baseRecordVersion,
      },
    });

    try {
      const committed = await runtime.controlPlane.commitSyncObject({
        deviceId: state.deviceId,
        afterSequence: state.currentSyncSequence,
        driveFileId: file.id,
        objectKind: 'event',
        sha256: encrypted.sha256,
        sizeBytes: encrypted.bytes.byteLength,
        recordType,
        recordId,
        baseRecordVersion,
        affectedRecords: event.affectedRecords,
      });
      if (committed.recordVersion !== event.recordVersion) {
        throw new Error('The committed record version does not match the encrypted event.');
      }
      if (JSON.stringify(committed.affectedRecords || []) !== JSON.stringify(event.affectedRecords || [])) {
        throw new Error('Committed affected-record versions do not match the encrypted event.');
      }
      await this.repository.applySyncEvent(event, committed.sequence);
      await runtime.controlPlane.updateDeviceCursor({
        deviceId: state.deviceId,
        lastAppliedSequence: committed.sequence,
      });
      await this.compactSnapshotWithRuntime(runtime, false).catch(error => {
        console.warn('Automatic encrypted snapshot compaction failed:', error);
      });
      return event;
    } catch (error) {
      if (
        error instanceof SupabaseControlPlaneError &&
        (error.message.includes('stale_sync_sequence') || error.message.includes('stale_record_version'))
      ) {
        await this.pullWithRuntime(runtime);
        if (operation === 'upsert' && payload && (recordType === 'entry' || recordType === 'note')) {
          const recoveredId = `${recordType}-recovered-${crypto.randomUUID()}`;
          const recoveredPayload = recordType === 'entry'
            ? {
                ...(payload as Entry),
                id: recoveredId,
                title: `${(payload as Entry).title || 'Untitled entry'} (Recovered copy)`,
                createdAt: this.now(),
                updatedAt: this.now(),
              }
            : {
                ...(payload as Extract<SyncPayload, { title: string }>),
                id: recoveredId,
                title: `${(payload as Extract<SyncPayload, { title: string }>).title || 'Untitled note'} (Recovered copy)`,
                createdAt: this.now(),
                updatedAt: this.now(),
              };
          await this.commitMutationUnlocked(recordType, 'upsert', recoveredId, recoveredPayload as SyncPayload);
          throw new SyncConflictError(
            `This ${recordType} changed on another device. Your pending version was saved as a recovered copy.`,
            recoveredId,
          );
        }
        throw new SyncConflictError('This record changed on another device. The latest version is now loaded.');
      }
      throw error;
    }
  }

  private async preparePayloadMedia(
    runtime: Awaited<ReturnType<EventSyncEngine['openRuntime']>>,
    recordType: SyncRecordType,
    payload: SyncPayload | null,
  ): Promise<SyncPayload | null> {
    if (!payload) return null;
    if (recordType === 'diary') {
      const diary = payload as Diary;
      return {
        ...diary,
        coverImage: diary.coverImage
          ? await this.prepareMediaUri(runtime, diary.coverImage)
          : undefined,
      };
    }
    if (recordType === 'profile') {
      const profile = payload as UserProfile;
      return {
        ...profile,
        avatarUri: profile.avatarUri
          ? await this.prepareMediaUri(runtime, profile.avatarUri)
          : undefined,
      };
    }
    if (recordType === 'settings') return payload as AppSettings;
    if (recordType !== 'entry') return payload;
    const entry = payload as Entry;
    return {
      ...entry,
      photoUris: await Promise.all(entry.photoUris.map(uri => this.prepareMediaUri(runtime, uri))),
      audioUri: entry.audioUri ? await this.prepareMediaUri(runtime, entry.audioUri) : undefined,
      blocks: entry.blocks ? await Promise.all(entry.blocks.map(async block => ({
        ...block,
        audioUri: block.audioUri ? await this.prepareMediaUri(runtime, block.audioUri) : undefined,
      }))) : undefined,
    };
  }

  private async prepareMediaUri(
    runtime: Awaited<ReturnType<EventSyncEngine['openRuntime']>>,
    uri: string,
  ): Promise<string> {
    if (parseSyncMediaReference(uri)) return uri;
    const knownReference = this.localMediaReferences.get(uri);
    if (knownReference) return knownReference;

    const mediaId = crypto.randomUUID();
    const media = await readMediaUri(uri);
    const payload = encodeSyncMediaPayload(mediaId, media.mimeType, media.bytes);
    const encrypted = await encryptSyncPayload(runtime.secrets.accountRootKey, 'media', payload);
    const state = await this.repository.getLocalSyncAccountState();
    if (!state) throw new Error('Encrypted account metadata is unavailable.');
    const expectedSequence = state.currentSyncSequence + 1;
    const file = await this.upload({
      session: runtime.googleSession,
      name: `/media/${mediaId}.ddmedia`,
      objectKind: 'media',
      bytes: encrypted.bytes,
      appProperties: { accountId: state.accountId, mediaId, expectedSequence },
    });
    const committed = await runtime.controlPlane.commitSyncObject({
      deviceId: state.deviceId,
      afterSequence: state.currentSyncSequence,
      driveFileId: file.id,
      objectKind: 'media',
      sha256: encrypted.sha256,
      sizeBytes: encrypted.bytes.byteLength,
    });
    const reference = createSyncMediaReference(committed.sequence, mediaId);
    await this.repository.saveSyncMediaPointer({
      mediaId,
      sequence: committed.sequence,
      driveFileId: committed.driveFileId,
      sha256: committed.sha256,
      sizeBytes: committed.sizeBytes,
      createdByDeviceId: committed.createdByDeviceId,
      createdAt: committed.createdAt,
      localUri: uri,
    });
    await this.repository.saveLocalSyncAccountState({ ...state, currentSyncSequence: committed.sequence });
    await runtime.controlPlane.updateDeviceCursor({
      deviceId: state.deviceId,
      lastAppliedSequence: committed.sequence,
    });
    this.localMediaReferences.set(uri, reference);
    this.resolvedMediaReferences.set(reference, uri);
    return reference;
  }

  private async resolveMediaReference(reference: string): Promise<string> {
    const parsed = parseSyncMediaReference(reference);
    if (!parsed) return reference;
    const cached = this.resolvedMediaReferences.get(reference);
    if (cached) return cached;
    const pointer = await this.repository.getSyncMediaPointer(parsed.sequence);
    if (!pointer) throw new Error('Synced media metadata is missing from this device.');
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
    const decrypted = await decryptSyncPayload(runtime.secrets.accountRootKey, encrypted);
    if (decrypted.objectKind !== 'media') throw new Error('Synced media object metadata is invalid.');
    const media = decodeSyncMediaPayload(decrypted.payload);
    if (media.mediaId !== parsed.mediaId) throw new Error('Synced media reference does not match its payload.');
    const localUri = await cacheSyncMedia(media.mediaId, media.mimeType, media.bytes);
    await this.repository.saveSyncMediaPointer({ ...pointer, mediaId: media.mediaId, localUri });
    this.resolvedMediaReferences.set(reference, localUri);
    this.localMediaReferences.set(localUri, reference);
    return localUri;
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
    const encrypted = await encryptSyncPayload(runtime.secrets.accountRootKey, 'snapshot', payload);
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
    await this.maintenance({
      controlPlane: runtime.controlPlane,
      primaryDeviceId: state.deviceId,
      googleSession: runtime.googleSession,
      now,
    });
    this.lastMaintenanceAt = now;
  }

  private async pullWithRuntime(runtime: Awaited<ReturnType<EventSyncEngine['openRuntime']>>): Promise<void> {
    let state = (await this.repository.getLocalSyncAccountState()) || runtime.state;
    while (true) {
      const objects = await runtime.controlPlane.listSyncObjectsAfter(state.deviceId, state.currentSyncSequence, 100);
      if (objects.length === 0) break;
      state = await replaySyncObjects({
        repository: this.repository,
        localState: state,
        accountRootKey: runtime.secrets.accountRootKey,
        googleSession: runtime.googleSession,
        objects,
      });
      if (objects.length < 100) break;
    }
    await runtime.controlPlane.updateDeviceCursor({
      deviceId: state.deviceId,
      lastAppliedSequence: state.currentSyncSequence,
    });
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
    if (!device || device.revokedAt) {
      this.stopPolling();
      await clearSyncSecrets();
      await this.repository.clearLocalSyncAccountState();
      if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('deardiary-device-revoked'));
      throw new Error('This device has been revoked. Recover or pair it again.');
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
