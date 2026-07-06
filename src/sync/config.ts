import {
  SupabaseControlPlaneClient,
  type SupabaseControlPlaneConfig,
} from './supabaseControlPlane';

export type SupabaseAccessTokenProvider = NonNullable<SupabaseControlPlaneConfig['accessToken']>;

const readViteEnv = (key: string): string => {
  const value = (import.meta.env[key] as string | undefined)?.trim();
  if (!value) throw new Error(`Missing ${key}. Add it to .env before enabling multi-device sync.`);
  return value;
};

export const getConfiguredSupabaseUrl = (): string => readViteEnv('VITE_SUPABASE_URL');

export const getConfiguredSupabaseAnonKey = (): string => readViteEnv('VITE_SUPABASE_ANON_KEY');

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
