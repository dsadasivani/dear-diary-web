export const SYNC_FAULT_POINTS = [
  'AFTER_LOCAL_RECORD_WRITE',
  'AFTER_OUTBOX_INSERT',
  'BEFORE_LOCAL_TRANSACTION_COMMIT',
  'BEFORE_EVENT_ENCRYPTION',
  'AFTER_EVENT_ENCRYPTION',
  'BEFORE_UPLOAD_INITIATE',
  'AFTER_UPLOAD_INITIATE',
  'DURING_OBJECT_UPLOAD',
  'AFTER_OBJECT_UPLOAD_BEFORE_LOCAL_PERSIST',
  'BEFORE_REMOTE_COMMIT',
  'AFTER_REMOTE_COMMIT_BEFORE_RESPONSE',
  'AFTER_COMMIT_RESPONSE_BEFORE_LOCAL_ACK',
  'BEFORE_REMOTE_DOWNLOAD',
  'AFTER_REMOTE_DOWNLOAD',
  'AFTER_HASH_VERIFICATION',
  'AFTER_DECRYPTION',
  'DURING_EVENT_APPLY',
  'AFTER_EVENT_APPLY_BEFORE_CURSOR',
  'AFTER_CURSOR_BEFORE_TRANSACTION_COMMIT',
  'AFTER_LOCAL_COMMIT_BEFORE_SERVER_ACK',
  'DURING_SNAPSHOT_IMPORT',
  'AFTER_KEY_CREATION',
  'AFTER_KEY_PACKAGE_UPLOAD',
  'AFTER_SERVER_EPOCH_COMMIT',
  'BEFORE_LOCAL_KEY_PERSIST',
  'DURING_RECOVERY_FINALIZATION',
  'DURING_GARBAGE_COLLECTION',
] as const;

export type SyncFaultPoint = (typeof SYNC_FAULT_POINTS)[number];
export interface SyncFaultInjector {
  hit(point: SyncFaultPoint): Promise<void>;
}
export const NOOP_SYNC_FAULT_INJECTOR: SyncFaultInjector = { hit: async () => undefined };
export class InjectedSyncCrash extends Error {
  constructor(readonly point: SyncFaultPoint) {
    super(`Injected sync crash at ${point}.`);
  }
}

export class TestSyncFaultInjector implements SyncFaultInjector {
  readonly hits: SyncFaultPoint[] = [];
  constructor(private readonly failures: Partial<Record<SyncFaultPoint, number>> = {}) {}
  async hit(point: SyncFaultPoint): Promise<void> {
    this.hits.push(point);
    const remaining = this.failures[point] || 0;
    if (remaining > 0) {
      this.failures[point] = remaining - 1;
      throw new InjectedSyncCrash(point);
    }
  }
}
