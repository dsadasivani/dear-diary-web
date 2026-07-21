import type { SupabaseAuthSession } from '../types';

export interface ExchangeGoogleIdTokenInput {
  supabaseUrl: string;
  anonKey: string;
  googleIdToken: string;
  nonce?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface RefreshSupabaseSessionInput {
  supabaseUrl: string;
  anonKey: string;
  refreshToken: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
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

const DEFAULT_AUTH_TIMEOUT_MS = 45_000;

const defaultFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);

const createTimeoutSignal = (timeoutMs: number): { signal: AbortSignal; cancel: () => void } => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timeoutId),
  };
};

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
};

export const exchangeGoogleIdTokenForSupabaseSession = async ({
  supabaseUrl,
  anonKey,
  googleIdToken,
  nonce,
  fetchImpl = defaultFetch,
  timeoutMs = DEFAULT_AUTH_TIMEOUT_MS,
}: ExchangeGoogleIdTokenInput): Promise<SupabaseAuthSession> => {
  if (!googleIdToken) throw new Error('Google did not return an ID token for Supabase sign-in.');
  const baseUrl = supabaseUrl.replace(/\/+$/, '');
  const timeout = createTimeoutSignal(timeoutMs);
  let response: Response;
  try {
    response = await withTimeout(
      fetchImpl(`${baseUrl}/auth/v1/token?grant_type=id_token`, {
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
        signal: timeout.signal,
      }),
      timeoutMs,
      'Supabase sign-in timed out. Check the emulator network connection and try again.',
    );
  } catch (error: any) {
    if (error?.name === 'AbortError')
      throw new Error(
        'Supabase sign-in timed out. Check the emulator network connection and try again.',
      );
    throw error;
  } finally {
    timeout.cancel();
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new SupabaseAuthExchangeError(
      payload?.msg ||
        payload?.message ||
        `Supabase Auth rejected the Google ID token (${response.status}).`,
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
  fetchImpl = defaultFetch,
  timeoutMs = DEFAULT_AUTH_TIMEOUT_MS,
}: RefreshSupabaseSessionInput): Promise<SupabaseAuthSession> => {
  const baseUrl = supabaseUrl.replace(/\/+$/, '');
  const timeout = createTimeoutSignal(timeoutMs);
  let response: Response;
  try {
    response = await withTimeout(
      fetchImpl(`${baseUrl}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: { apikey: anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }),
        signal: timeout.signal,
      }),
      timeoutMs,
      'Supabase session refresh timed out. Check the emulator network connection and try again.',
    );
  } catch (error: any) {
    if (error?.name === 'AbortError')
      throw new Error(
        'Supabase session refresh timed out. Check the emulator network connection and try again.',
      );
    throw error;
  } finally {
    timeout.cancel();
  }
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
