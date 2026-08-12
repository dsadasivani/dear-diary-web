import { isSyncError, SyncError, type SyncErrorCode } from '../../errors';
import type { SyncUploadInstruction } from '../api/SyncApiTypes';
import { NOOP_TELEMETRY, type Telemetry } from '../../../infrastructure/telemetry/Telemetry';

export interface TransferObject {
  objectKey: string;
  bytes: Uint8Array;
}

export interface BoundedTransferOptions {
  maximumConcurrency?: number;
  maximumObjectBytes: number;
  resumableUploadThresholdBytes?: number;
  resumableUploader?: (object: TransferObject, instruction: SyncUploadInstruction) => Promise<void>;
  fetch?: typeof fetch;
  telemetry?: Telemetry;
  requestTimeoutMs?: number;
  maximumAttempts?: number;
  retryBaseDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
}

export const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join(
    '',
  );
};

export const mapBounded = async <T, R>(
  values: readonly T[],
  maximumConcurrency: number,
  work: (value: T, index: number) => Promise<R>,
): Promise<R[]> => {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, maximumConcurrency), values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await work(values[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
};

export class BoundedObjectTransfer {
  private readonly fetcher: typeof fetch;
  private readonly concurrency: number;
  private readonly telemetry: Telemetry;
  private readonly requestTimeoutMs: number;
  private readonly maximumAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly sleep: (delayMs: number) => Promise<void>;

  constructor(private readonly options: BoundedTransferOptions) {
    const configuredFetcher = options.fetch;
    this.fetcher = configuredFetcher
      ? (input, init) => configuredFetcher(input, init)
      : (input, init) => globalThis.fetch(input, init);
    this.concurrency = options.maximumConcurrency || 3;
    this.telemetry = options.telemetry || NOOP_TELEMETRY;
    this.requestTimeoutMs = Math.max(1, options.requestTimeoutMs || 45_000);
    this.maximumAttempts = Math.max(1, options.maximumAttempts || 3);
    this.retryBaseDelayMs = Math.max(0, options.retryBaseDelayMs ?? 250);
    this.sleep =
      options.sleep || ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  }

  upload(objects: TransferObject[], instructions: SyncUploadInstruction[]): Promise<void[]> {
    const byKey = new Map(instructions.map((instruction) => [instruction.objectKey, instruction]));
    return mapBounded(objects, this.concurrency, async (object) => {
      const span = this.telemetry.startSpan('object.upload', {
        payload_size_bucket: this.sizeBucket(object.bytes.byteLength),
      });
      try {
        this.assertSize(object.bytes);
        const instruction = byKey.get(object.objectKey);
        if (!instruction)
          throw new SyncError({ code: 'OBJECT_UPLOAD_FAILED', safetyRelevant: true });
        if (
          this.options.resumableUploader &&
          object.bytes.byteLength >=
            (this.options.resumableUploadThresholdBytes || Number.MAX_SAFE_INTEGER)
        ) {
          await this.options.resumableUploader(object, instruction);
          return;
        }
        const headers = Object.fromEntries(
          Object.entries(instruction.headers).map(([key, values]) => [key, values.join(',')]),
        );
        await this.request(
          instruction.uploadUrl,
          {
            method: 'PUT',
            headers,
            body: object.bytes,
          },
          'OBJECT_UPLOAD_FAILED',
          undefined,
          this.timeoutForSize(object.bytes.byteLength),
        );
      } finally {
        span.end();
      }
    });
  }

  download<T extends { downloadUrl: string; sizeBytes: number; sha256: string }>(
    objects: T[],
  ): Promise<Uint8Array[]> {
    return mapBounded(objects, this.concurrency, async (object) => {
      const span = this.telemetry.startSpan('object.download', {
        payload_size_bucket: this.sizeBucket(object.sizeBytes),
      });
      try {
        if (object.sizeBytes > this.options.maximumObjectBytes) {
          throw new SyncError({ code: 'OBJECT_SIZE_MISMATCH', safetyRelevant: true });
        }
        const bytes = await this.request(
          object.downloadUrl,
          { method: 'GET' },
          'OBJECT_DOWNLOAD_FAILED',
          async (response) => new Uint8Array(await response.arrayBuffer()),
          this.timeoutForSize(object.sizeBytes),
        );
        if (bytes.byteLength !== object.sizeBytes)
          throw new SyncError({ code: 'OBJECT_SIZE_MISMATCH', safetyRelevant: true });
        if ((await sha256Hex(bytes)) !== object.sha256)
          throw new SyncError({ code: 'HASH_MISMATCH', safetyRelevant: true });
        return bytes;
      } finally {
        span.end();
      }
    });
  }

  private async request<T = void>(
    input: RequestInfo | URL,
    init: RequestInit,
    failureCode: Extract<SyncErrorCode, 'OBJECT_UPLOAD_FAILED' | 'OBJECT_DOWNLOAD_FAILED'>,
    consume: (response: Response) => Promise<T> = async () => undefined as T,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maximumAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await this.fetcher(input, { ...init, signal: controller.signal });
        if (!response.ok) {
          const retryable =
            response.status === 408 || response.status === 429 || response.status >= 500;
          throw new SyncError({ code: failureCode, retryable });
        }
        return await consume(response);
      } catch (error) {
        lastError = error;
        const retryable = isSyncError(error) ? error.retryable : true;
        if (!retryable || attempt === this.maximumAttempts) {
          if (isSyncError(error)) throw error;
          throw new SyncError({ code: failureCode, retryable: true, cause: error });
        }
      } finally {
        clearTimeout(timeout);
      }
      await this.sleep(this.retryBaseDelayMs * 2 ** (attempt - 1));
    }
    throw new SyncError({ code: failureCode, retryable: true, cause: lastError });
  }

  private timeoutForSize(sizeBytes: number): number {
    // Preserve a real deadline while allowing large snapshots to make progress
    // on slow mobile connections (approximately 128 KiB/s minimum throughput).
    return Math.max(this.requestTimeoutMs, Math.ceil((sizeBytes / (128 * 1024)) * 1_000));
  }

  private assertSize(bytes: Uint8Array): void {
    if (bytes.byteLength > this.options.maximumObjectBytes) {
      throw new SyncError({ code: 'OBJECT_SIZE_MISMATCH', safetyRelevant: true });
    }
  }

  private sizeBucket(bytes: number): string {
    if (bytes < 64 * 1024) return 'lt_64kb';
    if (bytes < 1024 * 1024) return 'lt_1mb';
    if (bytes < 10 * 1024 * 1024) return 'lt_10mb';
    return 'gte_10mb';
  }
}
