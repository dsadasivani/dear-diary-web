import { SyncError, isSyncError } from '../../sync/errors';
import type { SyncErrorCode } from '../../sync/errors';
import { createRequestDeadline, DEFAULT_REQUEST_TIMEOUT_MS } from './requestTimeout';
import {
  DEFAULT_RETRY_POLICY,
  fullJitterDelay,
  parseRetryAfterMs,
  type RetryPolicy,
} from './retryPolicy';

export interface ExecuteRequestOptions {
  request: (context: {
    signal: AbortSignal;
    correlationId: string;
    attempt: number;
  }) => Promise<Response>;
  mapError: (error: unknown) => SyncError;
  timeoutMs?: number;
  retryPolicy?: Partial<RetryPolicy>;
  signal?: AbortSignal;
  correlationId?: string;
  random?: () => number;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  isSuccessfulResponse?: (response: Response) => boolean;
}

const randomCorrelationId = (): string =>
  globalThis.crypto?.randomUUID?.() || `req-${Date.now().toString(36)}`;

const wait = (delayMs: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, delayMs);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

const responseError = (response: Response): Error & { status: number } => {
  const error = new Error('External request failed.') as Error & { status: number };
  error.status = response.status;
  return error;
};

export const executeRequest = async (options: ExecuteRequestOptions): Promise<Response> => {
  const policy: RetryPolicy = {
    ...DEFAULT_RETRY_POLICY,
    ...options.retryPolicy,
    retryableStatuses:
      options.retryPolicy?.retryableStatuses || DEFAULT_RETRY_POLICY.retryableStatuses,
  };
  const correlationId = options.correlationId || randomCorrelationId();
  const sleep = options.sleep || wait;
  let lastError: SyncError | undefined;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    if (options.signal?.aborted) {
      throw new SyncError({ code: 'UNKNOWN', cause: options.signal.reason });
    }
    const deadline = createRequestDeadline(
      options.timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS,
      options.signal,
    );
    try {
      const response = await options.request({ signal: deadline.signal, correlationId, attempt });
      if ((options.isSuccessfulResponse || ((candidate) => candidate.ok))(response))
        return response;
      const mapped = options.mapError(responseError(response));
      const retryable = policy.retryableStatuses.has(response.status) && mapped.retryable;
      if (!retryable || attempt >= policy.maxAttempts) throw mapped;
      lastError = mapped;
      const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
      await sleep(retryAfterMs ?? fullJitterDelay(attempt, policy, options.random), options.signal);
    } catch (error) {
      const cause =
        deadline.signal.aborted && !options.signal?.aborted
          ? new SyncError({ code: 'REQUEST_TIMEOUT', retryable: true, cause: error })
          : error;
      const mapped = isSyncError(cause) ? cause : options.mapError(cause);
      lastError = mapped;
      if (!mapped.retryable || attempt >= policy.maxAttempts) throw mapped;
      await sleep(
        mapped.retryAfterMs ?? fullJitterDelay(attempt, policy, options.random),
        options.signal,
      );
    } finally {
      deadline.dispose();
    }
  }
  throw lastError || new SyncError({ code: 'UNKNOWN' });
};

export const mapStatusToCode = (status: number): SyncErrorCode => {
  if (status === 408) return 'REQUEST_TIMEOUT';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'SERVER_UNAVAILABLE';
  return 'UNKNOWN';
};
