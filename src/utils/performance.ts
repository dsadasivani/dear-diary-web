export type MeasureMetadata = Record<string, unknown>;

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
  if (!isEnabled()) return operation();
  const startedAt = now();
  try {
    return await operation();
  } finally {
    recordMeasurement({
      name,
      durationMs: now() - startedAt,
      metadata: sanitizeMeasurementMetadata(metadata),
      startedAt,
    });
  }
};

export const getPerformanceAggregates = (): Record<string, AggregateMeasurement & { averageMs: number }> => (
  Object.fromEntries([...aggregates.entries()].map(([name, aggregate]) => [
    name,
    {
      ...aggregate,
      averageMs: aggregate.totalMs / aggregate.count,
    },
  ]))
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
