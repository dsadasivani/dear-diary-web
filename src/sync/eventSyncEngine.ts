import type { DiaryRepository } from '../repositories/DiaryRepository';
import type { Diary, Entry, UserProfile } from '../types';
import { parseSyncMediaReference } from './syncMedia';
import { isNativePlatform } from '../platform';
import { isDeviceLocalMediaUri } from './portableMedia';

/**
 * The application now has one sync runtime: Sync V2.  This facade remains so
 * repositories and screens do not need to know when that runtime is mounted.
 */
export interface SyncRuntimeDelegate {
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
  pullPending(): Promise<void>;
  flushPendingOutbox(): Promise<void>;
  requestOutboxFlush(delayMs?: number): void;
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

  pullPending(): Promise<void> {
    return this.runtimeDelegate?.pullPending() ?? Promise.resolve();
  }

  requestOutboxFlush(delayMs = 0): void {
    this.runtimeDelegate?.requestOutboxFlush(delayMs);
  }

  flushPendingOutbox(): Promise<void> {
    return this.runtimeDelegate?.flushPendingOutbox() ?? Promise.resolve();
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
    const pointer = parsed.sequence
      ? await this.repository.getSyncMediaPointer(parsed.sequence)
      : parsed.driveFileId
        ? await this.repository.getSyncMediaPointerByDriveFileId(parsed.driveFileId)
        : await this.repository.getSyncMediaPointerByMediaId(parsed.mediaId);
    return pointer?.localUri || reference;
  }

  startPolling(): void {
    void this.runtimeDelegate?.start();
  }

  stopPolling(): void {
    void this.runtimeDelegate?.stop();
  }
}
