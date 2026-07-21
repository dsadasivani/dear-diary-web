export type SyncTelemetryLevel = 'info' | 'warn' | 'error';

export interface SyncTelemetryEvent {
  name: string;
  level: SyncTelemetryLevel;
  at: number;
  data?: Record<string, unknown>;
}

export type SyncTelemetrySink = (event: SyncTelemetryEvent) => void;

let telemetrySink: SyncTelemetrySink | null = null;

const SENSITIVE_KEY =
  /(token|secret|pass|pin|answer|content|body|title|tag|mood|path|url|uri|payload|accountid|deviceid|fileid|recordid|objectkey|partitionkey|error)$/i;
const MAX_SAFE_STRING_LENGTH = 80;

const sanitizeValue = (value: unknown): unknown => {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string')
    return value.length <= MAX_SAFE_STRING_LENGTH ? value : '[redacted]';
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item));
  if (!value || typeof value !== 'object') return undefined;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !SENSITIVE_KEY.test(key))
      .map(([key, item]) => [key, sanitizeValue(item)]),
  );
};

export const sanitizeSyncTelemetryData = (
  data?: Record<string, unknown>,
): Record<string, unknown> | undefined =>
  data ? (sanitizeValue(data) as Record<string, unknown>) : undefined;

const shouldLogToConsole = (): boolean => {
  const globalDebug = (globalThis as any).__DEARDIARY_SYNC_DEBUG__;
  if (globalDebug === true) return true;
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage?.getItem('deardiary.sync.debug') === '1';
  } catch {
    return false;
  }
};

const dispatchBrowserEvent = (event: SyncTelemetryEvent): void => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('deardiary-sync-telemetry', { detail: event }));
};

export const setSyncTelemetrySink = (sink: SyncTelemetrySink | null): void => {
  telemetrySink = sink;
};

export const emitSyncTelemetry = (
  name: string,
  data?: Record<string, unknown>,
  level: SyncTelemetryLevel = 'info',
): SyncTelemetryEvent => {
  const event: SyncTelemetryEvent = {
    name,
    level,
    at: Date.now(),
    data: sanitizeSyncTelemetryData(data),
  };
  telemetrySink?.(event);
  dispatchBrowserEvent(event);
  if (shouldLogToConsole()) {
    const logger =
      level === 'error' ? console.error : level === 'warn' ? console.warn : console.info;
    logger(`[sync] ${name}`, event.data || {});
  }
  return event;
};
