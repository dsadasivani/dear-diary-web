import type { SupabaseAuthSession } from '../types';

export interface ExchangeGoogleIdTokenInput {
  supabaseUrl: string;
  anonKey: string;
  googleIdToken: string;
  nonce?: string;
  fetchImpl?: typeof fetch;
}

export interface RefreshSupabaseSessionInput {
  supabaseUrl: string;
  anonKey: string;
  refreshToken: string;
  fetchImpl?: typeof fetch;
}

export class SupabaseAuthExchangeError extends Error {
  readonly status: number;
  readonly detail: unknown;

  constructor(message: string, status: number, detail: unknown) {
    super(message);
    this.name = 'SupabaseAuthExchangeError';
    this.status = status;
    this.detail = detail;
  }
}

export const exchangeGoogleIdTokenForSupabaseSession = async ({
  supabaseUrl,
  anonKey,
  googleIdToken,
  nonce,
  fetchImpl = fetch,
}: ExchangeGoogleIdTokenInput): Promise<SupabaseAuthSession> => {
  if (!googleIdToken) throw new Error('Google did not return an ID token for Supabase sign-in.');
  const baseUrl = supabaseUrl.replace(/\/+$/, '');
  const response = await fetchImpl(`${baseUrl}/auth/v1/token?grant_type=id_token`, {
    method: 'POST',
    headers: {
      apikey: anonKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      provider: 'google',
      id_token: googleIdToken,
      nonce,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new SupabaseAuthExchangeError(
      payload?.msg || payload?.message || `Supabase Auth rejected the Google ID token (${response.status}).`,
      response.status,
      payload,
    );
  }

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token || null,
    expiresAt: payload.expires_at,
    userId: payload.user?.id,
    email: payload.user?.email || null,
  };
};

export const refreshSupabaseSession = async ({
  supabaseUrl,
  anonKey,
  refreshToken,
  fetchImpl = fetch,
}: RefreshSupabaseSessionInput): Promise<SupabaseAuthSession> => {
  const baseUrl = supabaseUrl.replace(/\/+$/, '');
  const response = await fetchImpl(`${baseUrl}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { apikey: anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new SupabaseAuthExchangeError(
      payload?.msg || payload?.message || `Supabase session refresh failed (${response.status}).`,
      response.status,
      payload,
    );
  }
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token || refreshToken,
    expiresAt: payload.expires_at,
    userId: payload.user?.id,
    email: payload.user?.email || null,
  };
};
