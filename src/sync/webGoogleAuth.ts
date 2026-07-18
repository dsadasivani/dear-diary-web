import type { Session, SupabaseClient } from '@supabase/supabase-js';
import type { GoogleAccountSession, SupabaseAuthSession } from '../types';
import { DRIVE_APPDATA_SCOPE } from '../utils/googleAuth';
import { getConfiguredSupabaseAnonKey, getConfiguredSupabaseUrl } from './config';
import {
  SYNC_SECRET_STORE,
  WebEncryptedKeyValueStore,
} from '../platform/storage/webEncryptedKeyValueStore';

export interface WebGoogleSyncSession {
  googleSession: GoogleAccountSession;
  supabaseSession: SupabaseAuthSession;
}

let clientPromise: Promise<SupabaseClient> | null = null;
const encryptedAuthStorage = new WebEncryptedKeyValueStore(SYNC_SECRET_STORE);

const getClient = async (): Promise<SupabaseClient> => {
  if (!clientPromise) {
    clientPromise = import('@supabase/supabase-js').then(({ createClient }) =>
      createClient(getConfiguredSupabaseUrl(), getConfiguredSupabaseAnonKey(), {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          storage: encryptedAuthStorage,
        },
      }),
    );
  }
  return clientPromise;
};

const mapSession = (session: Session): WebGoogleSyncSession => {
  const googleIdentity = session.user.identities?.find(
    (identity) => identity.provider === 'google',
  );
  const identityData = googleIdentity?.identity_data || session.user.user_metadata || {};
  const googleUserId = identityData.sub || identityData.provider_id;
  if (!googleUserId || !session.provider_token) {
    throw new Error(
      'Google sign-in did not return the identity and Drive token required for pairing.',
    );
  }
  return {
    googleSession: {
      userId: googleUserId,
      email: session.user.email || identityData.email || null,
      displayName: identityData.full_name || identityData.name || null,
      imageUrl: identityData.avatar_url || identityData.picture || null,
      accessToken: session.provider_token,
      idToken: null,
    },
    supabaseSession: {
      accessToken: session.access_token,
      refreshToken: session.refresh_token || null,
      expiresAt: session.expires_at,
      userId: session.user.id,
      email: session.user.email || null,
    },
  };
};

export const restoreWebGoogleSyncSession = async (): Promise<WebGoogleSyncSession | null> => {
  const client = await getClient();
  const { data, error } = await client.auth.getSession();
  if (error) throw error;
  return data.session ? mapSession(data.session) : null;
};

export const startWebGoogleSyncSignIn = async (): Promise<void> => {
  const client = await getClient();
  const { error } = await client.auth.signInWithOAuth({
    provider: 'google',
    options: {
      scopes: `openid email profile ${DRIVE_APPDATA_SCOPE}`,
      redirectTo: `${window.location.origin}${window.location.pathname}`,
      queryParams: { access_type: 'offline', prompt: 'consent' },
    },
  });
  if (error) throw error;
};

export const signOutWebGoogleSync = async (): Promise<void> => {
  const client = await getClient();
  await client.auth.signOut();
};
