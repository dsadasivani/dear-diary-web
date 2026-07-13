import { SyncError } from '../../errors';
import type { SyncV2UploadInstruction } from '../api/SyncV2ApiTypes';
import { NOOP_TELEMETRY, type Telemetry } from '../../../infrastructure/telemetry/Telemetry';

export interface TransferObject {
  objectKey: string;
  bytes: Uint8Array;
}

export interface BoundedTransferOptions {
  maximumConcurrency?: number;
  maximumObjectBytes: number;
  resumableUploadThresholdBytes?: number;
  resumableUploader?: (object: TransferObject, instruction: SyncV2UploadInstruction) => Promise<void>;
  fetch?: typeof fetch;
  telemetry?: Telemetry;
}

export const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
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

  constructor(private readonly options: BoundedTransferOptions) {
    this.fetcher = options.fetch || fetch;
    this.concurrency = options.maximumConcurrency || 3;
    this.telemetry = options.telemetry || NOOP_TELEMETRY;
  }

  upload(objects: TransferObject[], instructions: SyncV2UploadInstruction[]): Promise<void[]> {
    const byKey = new Map(instructions.map(instruction => [instruction.objectKey, instruction]));
    return mapBounded(objects, this.concurrency, async object => {
      const span = this.telemetry.startSpan('object.upload', { payload_size_bucket: this.sizeBucket(object.bytes.byteLength) });
      this.assertSize(object.bytes);
      const instruction = byKey.get(object.objectKey);
      if (!instruction) throw new SyncError({ code: 'OBJECT_UPLOAD_FAILED', safetyRelevant: true });
      if (
        this.options.resumableUploader &&
        object.bytes.byteLength >= (this.options.resumableUploadThresholdBytes || Number.MAX_SAFE_INTEGER)
      ) {
        await this.options.resumableUploader(object, instruction);
        span.end();
        return;
      }
      const headers = Object.fromEntries(Object.entries(instruction.headers).map(([key, values]) => [key, values.join(',')]));
      const response = await this.fetcher(instruction.uploadUrl, { method: 'PUT', headers, body: object.bytes });
      if (!response.ok) throw new SyncError({ code: 'OBJECT_UPLOAD_FAILED', retryable: response.status >= 500 });
      span.end();
    });
  }

  download<T extends { downloadUrl: string; sizeBytes: number; sha256: string }>(objects: T[]): Promise<Uint8Array[]> {
    return mapBounded(objects, this.concurrency, async object => {
      const span = this.telemetry.startSpan('object.download', { payload_size_bucket: this.sizeBucket(object.sizeBytes) });
      if (object.sizeBytes > this.options.maximumObjectBytes) {
        throw new SyncError({ code: 'OBJECT_SIZE_MISMATCH', safetyRelevant: true });
      }
      const response = await this.fetcher(object.downloadUrl, { method: 'GET' });
      if (!response.ok) throw new SyncError({ code: 'OBJECT_DOWNLOAD_FAILED', retryable: response.status >= 500 });
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength !== object.sizeBytes) throw new SyncError({ code: 'OBJECT_SIZE_MISMATCH', safetyRelevant: true });
      if (await sha256Hex(bytes) !== object.sha256) throw new SyncError({ code: 'HASH_MISMATCH', safetyRelevant: true });
      span.end();
      return bytes;
    });
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
