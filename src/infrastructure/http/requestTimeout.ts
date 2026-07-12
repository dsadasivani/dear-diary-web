import { SyncError } from '../../sync/errors';

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface RequestDeadline {
  signal: AbortSignal;
  dispose(): void;
}

export const createRequestDeadline = (
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  parentSignal?: AbortSignal,
): RequestDeadline => {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new SyncError({ code: 'REQUEST_TIMEOUT', retryable: true }));
  }, Math.max(1, timeoutMs));
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      parentSignal?.removeEventListener('abort', abortFromParent);
      if (timedOut) timedOut = false;
    },
  };
};

