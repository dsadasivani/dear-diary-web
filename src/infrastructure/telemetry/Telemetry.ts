export const TELEMETRY_ATTRIBUTES = [
  'platform',
  'app_version',
  'protocol_version',
  'storage_backend',
  'operation_type',
  'record_type',
  'outbox_state',
  'error_code',
  'retryable',
  'retry_count_bucket',
  'outbox_depth_bucket',
  'sequence_lag_bucket',
  'payload_size_bucket',
  'network_type',
  'device_role',
  'sync_mode',
] as const;

export type TelemetryAttributeName = (typeof TELEMETRY_ATTRIBUTES)[number];
export type TelemetryAttributes = Partial<
  Record<TelemetryAttributeName, string | number | boolean>
>;
export type TelemetryLevel = 'INFO' | 'WARN' | 'ERROR';

export interface TelemetrySpan {
  setAttribute(name: TelemetryAttributeName, value: string | number | boolean): void;
  end(errorCode?: string): void;
}

export interface Telemetry {
  counter(name: string, value: number, attributes?: TelemetryAttributes): void;
  histogram(name: string, value: number, attributes?: TelemetryAttributes): void;
  gauge(name: string, value: number, attributes?: TelemetryAttributes): void;
  event(name: string, level: TelemetryLevel, attributes?: TelemetryAttributes): void;
  startSpan(name: string, attributes?: TelemetryAttributes): TelemetrySpan;
}

export interface TelemetryEnvelope {
  kind: 'counter' | 'histogram' | 'gauge' | 'event' | 'span';
  name: string;
  value?: number;
  level?: TelemetryLevel;
  attributes: TelemetryAttributes;
  sessionId: string;
  at: number;
  durationMs?: number;
}

export interface TelemetryExporter {
  export(envelopes: TelemetryEnvelope[]): Promise<void>;
}

const safeName =
  /^(deardiary|sync|protocol|auth|outbox|record|event|events|object|operation|local|cursor|metadata|hash|snapshot)(\.[a-z0-9_]+)+$/;

export class PrivacySafeTelemetry implements Telemetry {
  private readonly sessionId = crypto.randomUUID();
  private readonly queue: TelemetryEnvelope[] = [];
  private flushTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly exporter: TelemetryExporter,
    private readonly batchSize = 50,
    private readonly flushIntervalMs = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  counter(name: string, value: number, attributes?: TelemetryAttributes): void {
    this.record('counter', name, value, attributes);
  }
  histogram(name: string, value: number, attributes?: TelemetryAttributes): void {
    this.record('histogram', name, value, attributes);
  }
  gauge(name: string, value: number, attributes?: TelemetryAttributes): void {
    this.record('gauge', name, value, attributes);
  }
  event(name: string, level: TelemetryLevel, attributes?: TelemetryAttributes): void {
    this.enqueue({
      kind: 'event',
      name: this.validateName(name),
      level,
      attributes: this.attributes(attributes),
      sessionId: this.sessionId,
      at: this.now(),
    });
  }
  startSpan(name: string, attributes?: TelemetryAttributes): TelemetrySpan {
    const startedAt = this.now();
    const spanAttributes = this.attributes(attributes);
    return {
      setAttribute: (key, value) => {
        spanAttributes[key] = value;
      },
      end: (errorCode) =>
        this.enqueue({
          kind: 'span',
          name: this.validateName(name),
          attributes: this.attributes({
            ...spanAttributes,
            ...(errorCode ? { error_code: errorCode } : {}),
          }),
          sessionId: this.sessionId,
          at: startedAt,
          durationMs: Math.max(0, this.now() - startedAt),
        }),
    };
  }

  async flush(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.batchSize);
    try {
      await this.exporter.export(batch);
    } catch {
      this.queue.unshift(...batch);
    }
    if (this.queue.length > 0) this.scheduleFlush();
  }

  private record(
    kind: TelemetryEnvelope['kind'],
    name: string,
    value: number,
    attributes?: TelemetryAttributes,
  ): void {
    if (!Number.isFinite(value)) return;
    this.enqueue({
      kind,
      name: this.validateName(name),
      value,
      attributes: this.attributes(attributes),
      sessionId: this.sessionId,
      at: this.now(),
    });
  }

  private enqueue(envelope: TelemetryEnvelope): void {
    this.queue.push(envelope);
    if (this.queue.length >= this.batchSize) void this.flush();
    else this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (!this.flushTimer)
      this.flushTimer = setTimeout(() => void this.flush(), this.flushIntervalMs);
  }

  private validateName(name: string): string {
    if (!safeName.test(name)) throw new Error('Telemetry name is not allowlisted.');
    return name;
  }

  private attributes(attributes: TelemetryAttributes = {}): TelemetryAttributes {
    return Object.fromEntries(
      Object.entries(attributes).filter(
        ([key, value]) =>
          (TELEMETRY_ATTRIBUTES as readonly string[]).includes(key) &&
          ['string', 'number', 'boolean'].includes(typeof value),
      ),
    ) as TelemetryAttributes;
  }
}

export class HttpTelemetryExporter implements TelemetryExporter {
  constructor(
    private readonly endpoint: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  async export(envelopes: TelemetryEnvelope[]): Promise<void> {
    const response = await this.fetcher(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ envelopes }),
      keepalive: true,
    });
    if (!response.ok) throw new Error('Telemetry export failed.');
  }
}

export const NOOP_TELEMETRY: Telemetry = {
  counter: () => undefined,
  histogram: () => undefined,
  gauge: () => undefined,
  event: () => undefined,
  startSpan: () => ({ setAttribute: () => undefined, end: () => undefined }),
};
