import assert from 'node:assert/strict';
import test from 'node:test';
import { exchangeGoogleIdTokenForSupabaseSession, refreshSupabaseSession, SupabaseAuthExchangeError } from './supabaseAuth';

test('exchanges a Google ID token for a Supabase Auth session', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const session = await exchangeGoogleIdTokenForSupabaseSession({
    supabaseUrl: 'https://example.supabase.co/',
    anonKey: 'anon-key',
    googleIdToken: 'google-id-token',
    fetchImpl: async (input, init = {}) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({
        access_token: 'supabase-access-token',
        refresh_token: 'supabase-refresh-token',
        expires_at: 1780000000,
        user: { id: 'user-1', email: 'writer@example.com' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });

  assert.equal(session.accessToken, 'supabase-access-token');
  assert.equal(session.refreshToken, 'supabase-refresh-token');
  assert.equal(calls[0].url, 'https://example.supabase.co/auth/v1/token?grant_type=id_token');
  assert.equal(new Headers(calls[0].init.headers).get('apikey'), 'anon-key');
  assert.equal(calls[0].init.body, JSON.stringify({
    provider: 'google',
    id_token: 'google-id-token',
  }));
});

test('refreshes an existing Supabase session', async () => {
  let body = '';
  const session = await refreshSupabaseSession({
    supabaseUrl: 'https://example.supabase.co',
    anonKey: 'anon',
    refreshToken: 'refresh-old',
    fetchImpl: async (_input, init) => {
      body = String(init?.body);
      return new Response(JSON.stringify({
        access_token: 'access-new',
        refresh_token: 'refresh-new',
        expires_at: 2_000_000_000,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });

  assert.equal(body, JSON.stringify({ refresh_token: 'refresh-old' }));
  assert.equal(session.accessToken, 'access-new');
  assert.equal(session.refreshToken, 'refresh-new');
});

test('surfaces Supabase Auth exchange failures', async () => {
  await assert.rejects(
    () => exchangeGoogleIdTokenForSupabaseSession({
      supabaseUrl: 'https://example.supabase.co',
      anonKey: 'anon-key',
      googleIdToken: 'bad-token',
      fetchImpl: async () => new Response(JSON.stringify({ message: 'Bad ID token' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    }),
    (error: unknown) => (
      error instanceof SupabaseAuthExchangeError &&
      error.status === 400 &&
      error.message === 'Bad ID token'
    ),
  );
});
