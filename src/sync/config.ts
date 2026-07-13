import {
  SupabaseControlPlaneClient,
  type SupabaseControlPlaneConfig,
} from './supabaseControlPlane';
import { SyncV2ApiClient, type SyncV2AccessTokenProvider } from './v2';

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
): SupabaseControlPlaneClient => new SupabaseControlPlaneClient(
  getConfiguredSupabaseControlPlaneConfig(accessToken),
);

export const createConfiguredSyncV2ApiClient = (
  accessToken: SyncV2AccessTokenProvider,
): SyncV2ApiClient => new SyncV2ApiClient({
  baseUrl: getConfiguredSyncV2ApiUrl(),
  accessToken,
});
