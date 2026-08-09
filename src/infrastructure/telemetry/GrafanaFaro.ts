import {
  initializeFaro,
  SessionInstrumentation,
  type BrowserConfig,
  type Faro,
} from '@grafana/faro-web-sdk';
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

export const createGrafanaFaroConfig = (
  url: string,
  environment: string,
  releaseVersion: string,
): BrowserConfig => ({
  url,
  app: {
    name: 'dear-diary-client',
    namespace: 'dear-diary',
    environment,
    version: releaseVersion,
  },
  // The collector requires a Faro session id. Keep only the session lifecycle instrumentation;
  // diary routes, console messages, errors, performance entries, and browser metadata stay off.
  instrumentations: [new SessionInstrumentation()],
  metas: [],
  preventGlobalExposure: true,
  sessionTracking: { enabled: true, persistent: false },
  trackGeolocation: false,
});

export const createGrafanaFaro = (url: string, environment: string, releaseVersion: string): Faro =>
  initializeFaro(createGrafanaFaroConfig(url, environment, releaseVersion));

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
