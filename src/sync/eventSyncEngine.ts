import type { DiaryRepository } from '../repositories/DiaryRepository';
import type { Diary, Entry, UserProfile } from '../types';
import { parseSyncMediaReference } from './syncMedia';
import { isNativePlatform } from '../platform';
import { isDeviceLocalMediaUri } from './portableMedia';

/**
 * The application now has one sync runtime: Loredays Sync.  This facade remains so
 * repositories and screens do not need to know when that runtime is mounted.
 */
export interface SyncRuntimeDelegate {
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
  pullPending(): Promise<void>;
  flushPendingOutbox(): Promise<void>;
  retryPendingOutboxNow(): Promise<void>;
  requestOutboxFlush(delayMs?: number): void;
  hydrateMediaReference?(reference: string): Promise<string>;
}

export interface SyncCatchUpProgress {
  phase:
    | 'starting'
    | 'restoring-snapshot'
    | 'downloading-events'
    | 'applying-events'
    | 'opening'
    | 'complete'
    | 'failed';
  startingSequence: number;
  snapshotSequence?: number;
  appliedSequence: number;
  targetSequence?: number;
  downloadedEvents?: number;
  appliedEvents?: number;
  totalEvents?: number;
  errorCode?: string;
  error?: string;
  recoverable?: boolean;
}

export interface EventSyncEngineDependencies {
  // Retained only to keep repository construction independent of the runtime.
  outboxRepository?: unknown;
}

export class SyncConflictError extends Error {
  constructor(
    message: string,
    readonly recoveredRecordId?: string,
  ) {
    super(message);
    this.name = 'SyncConflictError';
  }
}

export class EventSyncEngine {
  private runtimeDelegate: SyncRuntimeDelegate | null = null;
  private readonly catchUpListeners = new Set<(progress: SyncCatchUpProgress) => void>();

  constructor(
    private readonly repository: DiaryRepository,
    _dependencies: EventSyncEngineDependencies = {},
  ) {
    void _dependencies;
  }

  installRuntimeDelegate(delegate: SyncRuntimeDelegate | null): void {
    if (this.runtimeDelegate === delegate) return;
    if (this.runtimeDelegate) void this.runtimeDelegate.stop();
    this.runtimeDelegate = delegate;
  }

  subscribeCatchUpProgress(listener: (progress: SyncCatchUpProgress) => void): () => void {
    this.catchUpListeners.add(listener);
    return () => this.catchUpListeners.delete(listener);
  }

  reportCatchUpProgress(progress: SyncCatchUpProgress): void {
    void this.repository
      .updateSyncCatchUpStatus({
        catchUpPhase: progress.phase,
        startingSequence: progress.startingSequence,
        snapshotSequence: progress.snapshotSequence,
        appliedSequence: progress.appliedSequence,
        targetSequence: progress.targetSequence,
        downloadedEvents: progress.downloadedEvents,
        appliedEvents: progress.appliedEvents,
        totalEvents: progress.totalEvents,
        catchUpErrorCode: progress.errorCode,
        catchUpError: progress.error,
        catchUpRecoverable: progress.recoverable,
      })
      .catch(() => undefined);
    this.catchUpListeners.forEach((listener) => listener(progress));
  }

  pullPending(): Promise<void> {
    return this.runtimeDelegate?.pullPending() ?? Promise.resolve();
  }

  requestOutboxFlush(delayMs = 0): void {
    this.runtimeDelegate?.requestOutboxFlush(delayMs);
  }

  flushPendingOutbox(): Promise<void> {
    return this.runtimeDelegate?.flushPendingOutbox() ?? Promise.resolve();
  }

  retryPendingOutboxNow(): Promise<void> {
    return this.runtimeDelegate?.retryPendingOutboxNow() ?? Promise.resolve();
  }

  async reauthorize(): Promise<void> {
    if (!this.runtimeDelegate) throw new Error('Encrypted sync is not configured.');
    await this.runtimeDelegate.stop();
    await this.runtimeDelegate.start();
    await this.runtimeDelegate.pullPending();
  }

  hydrateArchivePartition(_partitionKey: string): Promise<void> {
    void _partitionKey;
    return this.pullPending();
  }

  async hydrateDiary(diary: Diary): Promise<Diary> {
    if (!diary.coverImage) return diary;
    return { ...diary, coverImage: await this.hydrateMediaReference(diary.coverImage) };
  }

  hydrateDiaries(diaries: Diary[]): Promise<Diary[]> {
    return Promise.all(diaries.map((diary) => this.hydrateDiary(diary)));
  }

  async hydrateEntries(entries: Entry[]): Promise<Entry[]> {
    return Promise.all(
      entries.map(async (entry) => ({
        ...entry,
        photoUris: await Promise.all(entry.photoUris.map((uri) => this.hydrateMediaReference(uri))),
        audioUri: entry.audioUri ? await this.hydrateMediaReference(entry.audioUri) : undefined,
        blocks: entry.blocks
          ? await Promise.all(
              entry.blocks.map(async (block) => ({
                ...block,
                audioUri: block.audioUri
                  ? await this.hydrateMediaReference(block.audioUri)
                  : undefined,
              })),
            )
          : undefined,
      })),
    );
  }

  async hydrateProfile(profile: UserProfile): Promise<UserProfile> {
    if (!profile.avatarUri) return profile;
    return { ...profile, avatarUri: await this.hydrateMediaReference(profile.avatarUri) };
  }

  async hydrateMediaReference(reference: string, _label = 'media'): Promise<string> {
    void _label;
    if (!isNativePlatform() && isDeviceLocalMediaUri(reference)) return '';
    const parsed = parseSyncMediaReference(reference);
    if (!parsed) return reference;
    const pointer = await this.repository.getSyncMediaPointerByMediaId(parsed.mediaId);
    if (pointer?.localUri) return pointer.localUri;
    return this.runtimeDelegate?.hydrateMediaReference?.(reference) || reference;
  }

  startPolling(): void {
    void this.runtimeDelegate?.start();
  }

  stopPolling(): void {
    void this.runtimeDelegate?.stop();
  }
}
