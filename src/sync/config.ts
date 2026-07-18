import {
  SupabaseControlPlaneClient,
  type SupabaseControlPlaneConfig,
} from './supabaseControlPlane';
import { SyncV2ApiClient, type SyncV2AccessTokenProvider } from './v2';
import {
  HttpTelemetryExporter,
  NOOP_TELEMETRY,
  PrivacySafeTelemetry,
  type Telemetry,
} from '../infrastructure/telemetry/Telemetry';
import {
  AdapterCrashReporter,
  NOOP_CRASH_REPORTER,
  type CrashReporter,
} from '../infrastructure/telemetry/CrashReporter';

export type SupabaseAccessTokenProvider = NonNullable<SupabaseControlPlaneConfig['accessToken']>;

const readViteEnv = (key: string): string => {
  const value = (import.meta.env[key] as string | undefined)?.trim();
  if (!value) throw new Error(`Missing ${key}. Add it to .env before enabling multi-device sync.`);
  return value;
};

export const getConfiguredSupabaseUrl = (): string => readViteEnv('VITE_SUPABASE_URL');

export const getConfiguredSupabaseAnonKey = (): string => readViteEnv('VITE_SUPABASE_ANON_KEY');

export const getConfiguredSyncV2ApiUrl = (): string => readViteEnv('VITE_SYNC_V2_API_URL');

export const getConfiguredSupabaseControlPlaneConfig = (
  accessToken: SupabaseAccessTokenProvider,
): SupabaseControlPlaneConfig => ({
  url: getConfiguredSupabaseUrl(),
  anonKey: getConfiguredSupabaseAnonKey(),
  accessToken,
});

export const createConfiguredSupabaseControlPlaneClient = (
  accessToken: SupabaseAccessTokenProvider,
): SupabaseControlPlaneClient =>
  new SupabaseControlPlaneClient(getConfiguredSupabaseControlPlaneConfig(accessToken));

export const createConfiguredSyncV2ApiClient = (
  accessToken: SyncV2AccessTokenProvider,
): SyncV2ApiClient =>
  new SyncV2ApiClient({
    baseUrl: getConfiguredSyncV2ApiUrl(),
    accessToken,
  });

export const createConfiguredTelemetry = (): Telemetry => {
  const endpoint = (import.meta.env.VITE_TELEMETRY_ENDPOINT as string | undefined)?.trim();
  return endpoint ? new PrivacySafeTelemetry(new HttpTelemetryExporter(endpoint)) : NOOP_TELEMETRY;
};

export const createConfiguredCrashReporter = (): CrashReporter => {
  const endpoint = (import.meta.env.VITE_CRASH_REPORT_ENDPOINT as string | undefined)?.trim();
  if (!endpoint) return NOOP_CRASH_REPORTER;
  return new AdapterCrashReporter((report) => {
    void fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report),
      keepalive: true,
    }).catch(() => undefined);
  });
};
