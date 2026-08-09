import { SyncV2ApiClient, type SyncV2AccessTokenProvider } from './v2';
import {
  NOOP_TELEMETRY,
  PrivacySafeTelemetry,
  type Telemetry,
} from '../infrastructure/telemetry/Telemetry';
import {
  AdapterCrashReporter,
  NOOP_CRASH_REPORTER,
  type CrashReporter,
} from '../infrastructure/telemetry/CrashReporter';
import { APP_ENVIRONMENT } from '../config/environment';
import {
  createGrafanaFaro,
  GrafanaFaroTelemetryExporter,
  reportCrashToGrafana,
} from '../infrastructure/telemetry/GrafanaFaro';
import type { Faro } from '@grafana/faro-web-sdk';

const readViteEnv = (key: string): string => {
  const value = (import.meta.env[key] as string | undefined)?.trim();
  if (!value)
    throw new Error(
      `Missing ${key} for ${APP_ENVIRONMENT}. Add it to the environment-specific configuration before enabling multi-device sync.`,
    );
  return value;
};

export const getConfiguredAppEnvironment = () => APP_ENVIRONMENT;

export const getConfiguredSupabaseUrl = (): string => readViteEnv('VITE_SUPABASE_URL');

export const getConfiguredSupabaseAnonKey = (): string => readViteEnv('VITE_SUPABASE_ANON_KEY');

export const getConfiguredSyncV2ApiUrl = (): string => readViteEnv('VITE_SYNC_V2_API_URL');

export const createConfiguredSyncV2ApiClient = (
  accessToken: SyncV2AccessTokenProvider,
): SyncV2ApiClient =>
  new SyncV2ApiClient({
    baseUrl: getConfiguredSyncV2ApiUrl(),
    accessToken,
  });

let configuredFaro: Faro | undefined;

const getConfiguredFaro = (): Faro | undefined => {
  const url = (import.meta.env.VITE_GRAFANA_FARO_URL as string | undefined)?.trim();
  if (!url) return undefined;
  configuredFaro ??= createGrafanaFaro(
    url,
    APP_ENVIRONMENT,
    (import.meta.env.VITE_TELEMETRY_RELEASE_VERSION as string | undefined)?.trim() || 'unknown',
  );
  return configuredFaro;
};

export const createConfiguredTelemetry = (): Telemetry => {
  const faro = getConfiguredFaro();
  return faro ? new PrivacySafeTelemetry(new GrafanaFaroTelemetryExporter(faro)) : NOOP_TELEMETRY;
};

export const createConfiguredCrashReporter = (): CrashReporter => {
  const faro = getConfiguredFaro();
  return faro
    ? new AdapterCrashReporter((report) => reportCrashToGrafana(faro, report))
    : NOOP_CRASH_REPORTER;
};
