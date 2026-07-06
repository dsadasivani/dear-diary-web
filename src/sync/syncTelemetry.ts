export type SyncTelemetryLevel = 'info' | 'warn' | 'error';

export interface SyncTelemetryEvent {
  name: string;
  level: SyncTelemetryLevel;
  at: number;
  data?: Record<string, unknown>;
}

export type SyncTelemetrySink = (event: SyncTelemetryEvent) => void;

let telemetrySink: SyncTelemetrySink | null = null;

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
    data,
  };
  telemetrySink?.(event);
  dispatchBrowserEvent(event);
  if (shouldLogToConsole()) {
    const logger = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info;
    logger(`[sync] ${name}`, data || {});
  }
  return event;
};

