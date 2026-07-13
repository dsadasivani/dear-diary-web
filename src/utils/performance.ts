export type MeasureMetadata = Record<string, unknown>;
import type { Telemetry } from '../infrastructure/telemetry/Telemetry';

interface MeasurementSample {
  name: string;
  durationMs: number;
  metadata?: MeasureMetadata;
  startedAt: number;
}

interface AggregateMeasurement {
  count: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
  lastMs: number;
}

const PRIVATE_KEY_PATTERN = /(body|text|title|token|secret|key|pin|passphrase|password|recovery|answer|media|bytes|uri|html|content)/i;
const MAX_METADATA_VALUE_LENGTH = 80;
const aggregates = new Map<string, AggregateMeasurement>();
const samples: MeasurementSample[] = [];
const MAX_SAMPLES = 500;
let productionTelemetry: Telemetry | null = null;

export const setPerformanceTelemetry = (telemetry: Telemetry | null): void => { productionTelemetry = telemetry; };

const telemetryMetricFor = (name: string): string | undefined => {
  if (name.startsWith('repository.local.') || name === 'repository.local.mutationWithOutbox') return 'deardiary.local_write.duration_ms';
  if (name === 'repository.initialize' || name.startsWith('sqlite.bridge')) return 'deardiary.database.open.duration_ms';
  if (name.includes('outbox.operation')) return 'deardiary.outbox.operation.duration_ms';
  if (name.includes('sync.pull')) return 'deardiary.sync.cycle.duration_ms';
  if (name.includes('query.homeSummary')) return 'deardiary.screen.home.load_ms';
  if (name.includes('query.entries.list')) return 'deardiary.screen.diary.load_ms';
  if (name.includes('search')) return 'deardiary.screen.search.duration_ms';
  if (name.includes('stats') || name.includes('Statistics')) return 'deardiary.screen.stats.duration_ms';
  if (name.includes('crypto.encrypt')) return 'deardiary.media.encrypt.duration_ms';
  if (name.includes('drive.upload')) return 'deardiary.media.upload.duration_ms';
  if (name.includes('drive.download')) return 'deardiary.media.download.duration_ms';
  return undefined;
};

const emitProductionMeasurement = (name: string, durationMs: number, succeeded: boolean): void => {
  const metric = telemetryMetricFor(name);
  if (!metric || !productionTelemetry) return;
  productionTelemetry.histogram(metric, durationMs);
  if (metric === 'deardiary.local_write.duration_ms') {
    productionTelemetry.counter(succeeded ? 'deardiary.local_write.success' : 'deardiary.local_write.failure', 1);
  }
  if (metric === 'deardiary.database.open.duration_ms') {
    productionTelemetry.counter(succeeded ? 'deardiary.database.open.success' : 'deardiary.database.open.failure', 1);
  }
};

const isProduction = (): boolean => {
  try {
    return import.meta.env.PROD;
  } catch {
    return process.env.NODE_ENV === 'production';
  }
};

const isEnabled = (): boolean => {
  if (isProduction()) return false;
  if (typeof localStorage !== 'undefined' && localStorage.getItem('deardiary_perf') === 'off') return false;
  return true;
};

const now = (): number => (
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
);

const sanitizeValue = (value: unknown): unknown => {
  if (value === null || value === undefined) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return value.length > MAX_METADATA_VALUE_LENGTH
      ? `${value.slice(0, MAX_METADATA_VALUE_LENGTH)}...`
      : value;
  }
  if (Array.isArray(value)) return { count: value.length };
  if (typeof value === 'object') return '[object]';
  return String(value);
};

export const sanitizeMeasurementMetadata = (metadata?: MeasureMetadata): MeasureMetadata | undefined => {
  if (!metadata) return undefined;
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [
      key,
      PRIVATE_KEY_PATTERN.test(key) ? '[redacted]' : sanitizeValue(value),
    ]),
  );
};

const recordMeasurement = (sample: MeasurementSample): void => {
  const current = aggregates.get(sample.name);
  aggregates.set(sample.name, current ? {
    count: current.count + 1,
    totalMs: current.totalMs + sample.durationMs,
    minMs: Math.min(current.minMs, sample.durationMs),
    maxMs: Math.max(current.maxMs, sample.durationMs),
    lastMs: sample.durationMs,
  } : {
    count: 1,
    totalMs: sample.durationMs,
    minMs: sample.durationMs,
    maxMs: sample.durationMs,
    lastMs: sample.durationMs,
  });
  samples.push(sample);
  if (samples.length > MAX_SAMPLES) samples.shift();
};

export const recordPerformanceMeasurement = (
  name: string,
  durationMs: number,
  metadata?: MeasureMetadata,
  startedAt = now() - durationMs,
): void => {
  if (!isEnabled()) return;
  recordMeasurement({
    name,
    durationMs,
    metadata: sanitizeMeasurementMetadata(metadata),
    startedAt,
  });
};

export const measureSync = <T>(
  name: string,
  operation: () => T,
  metadata?: MeasureMetadata,
): T => {
  if (!isEnabled()) return operation();
  const startedAt = now();
  try {
    return operation();
  } finally {
    recordMeasurement({
      name,
      durationMs: now() - startedAt,
      metadata: sanitizeMeasurementMetadata(metadata),
      startedAt,
    });
  }
};

export const measureAsync = async <T>(
  name: string,
  operation: () => Promise<T>,
  metadata?: MeasureMetadata,
): Promise<T> => {
  const localMeasurementEnabled = isEnabled();
  if (!localMeasurementEnabled && !productionTelemetry) return operation();
  const startedAt = now();
  let succeeded = false;
  try {
    const result = await operation();
    succeeded = true;
    return result;
  } finally {
    const durationMs = now() - startedAt;
    emitProductionMeasurement(name, durationMs, succeeded);
    if (localMeasurementEnabled) recordMeasurement({
      name, durationMs, metadata: sanitizeMeasurementMetadata(metadata), startedAt,
    });
  }
};

const percentile = (values: number[], percentileRank: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentileRank / 100) * sorted.length) - 1));
  return sorted[index];
};

export const getPerformanceAggregates = (): Record<string, AggregateMeasurement & {
  averageMs: number;
  p50Ms: number;
  p95Ms: number;
}> => (
  Object.fromEntries([...aggregates.entries()].map(([name, aggregate]) => {
    const durations = samples
      .filter(sample => sample.name === name)
      .map(sample => sample.durationMs);
    return [
      name,
      {
        ...aggregate,
        averageMs: aggregate.totalMs / aggregate.count,
        p50Ms: percentile(durations, 50),
        p95Ms: percentile(durations, 95),
      },
    ];
  }))
);

export const getRecentPerformanceSamples = (): MeasurementSample[] => [...samples];

export const resetPerformanceMeasurements = (): void => {
  aggregates.clear();
  samples.length = 0;
};

if (typeof window !== 'undefined') {
  (window as typeof window & {
    dearDiaryPerformance?: {
      aggregates: typeof getPerformanceAggregates;
      samples: typeof getRecentPerformanceSamples;
      reset: typeof resetPerformanceMeasurements;
    };
  }).dearDiaryPerformance = {
    aggregates: getPerformanceAggregates,
    samples: getRecentPerformanceSamples,
    reset: resetPerformanceMeasurements,
  };
}
