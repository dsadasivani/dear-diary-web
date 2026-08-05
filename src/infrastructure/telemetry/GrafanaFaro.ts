import { initializeFaro, type Faro } from '@grafana/faro-web-sdk';
import type { CrashReportContext } from './CrashReporter';
import type { TelemetryEnvelope, TelemetryExporter } from './Telemetry';

const stringifyAttributes = (
  attributes: Record<string, string | number | boolean | undefined>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(attributes)
      .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
      .map(([key, value]) => [key, String(value)]),
  );

export const createGrafanaFaro = (url: string, environment: string, releaseVersion: string): Faro =>
  initializeFaro({
    url,
    app: {
      name: 'dear-diary-client',
      namespace: 'dear-diary',
      environment,
      version: releaseVersion,
    },
    // Diary routes, console messages, and browser metadata can contain private context. Only the
    // explicitly allowlisted signals below are sent to Grafana Cloud.
    instrumentations: [],
    metas: [],
    preventGlobalExposure: true,
    sessionTracking: { enabled: true, persistent: false },
    trackGeolocation: false,
  });

export class GrafanaFaroTelemetryExporter implements TelemetryExporter {
  constructor(private readonly faro: Faro) {}

  async export(envelopes: TelemetryEnvelope[]): Promise<void> {
    for (const envelope of envelopes) {
      const context = stringifyAttributes({ ...envelope.attributes, signal_kind: envelope.kind });
      const timestampOverwriteMs = envelope.at;

      if (envelope.kind === 'event') {
        this.faro.api.pushEvent(
          envelope.name,
          { ...context, level: envelope.level ?? 'INFO' },
          'dear-diary',
          { timestampOverwriteMs },
        );
        continue;
      }

      this.faro.api.pushMeasurement(
        {
          type: envelope.name,
          values:
            envelope.kind === 'span'
              ? { duration_ms: envelope.durationMs ?? 0 }
              : { value: envelope.value ?? 0 },
          context,
        },
        { timestampOverwriteMs },
      );
    }
  }
}

export const reportCrashToGrafana = (
  faro: Faro,
  report: { name: string; context: CrashReportContext },
): void => {
  const error = new Error();
  error.name = report.name;
  error.stack = undefined;
  faro.api.pushError(error, {
    type: report.name,
    stackFrames: [],
    context: stringifyAttributes({ ...report.context }),
  });
};
