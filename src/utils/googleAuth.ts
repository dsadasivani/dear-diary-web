import { GoogleSignIn } from '@capawesome/capacitor-google-sign-in';
import type { SignInResult } from '@capawesome/capacitor-google-sign-in';
import { isNativePlatform } from '../platform';
import type { GoogleAccountSession } from '../types';

export type GoogleAuthIntent = 'pin-reset' | 'sync';

const GOOGLE_AUTH_INTENT_KEY = 'deardiary_google_auth_intent';
const GOOGLE_SIGN_IN_TIMEOUT_MS = 90_000;
let initializedClientId = '';

const getGoogleWebClientId = (): string => {
  const clientId = (import.meta.env.VITE_GOOGLE_WEB_CLIENT_ID as string | undefined)?.trim();
  if (!clientId) throw new Error('Google sign-in is not configured for this app build.');
  return clientId;
};

const initializeNativeGoogleSignIn = async (): Promise<void> => {
  const clientId = getGoogleWebClientId();
  if (initializedClientId === clientId) return;
  await GoogleSignIn.initialize({ clientId, scopes: ['openid', 'email', 'profile'] });
  initializedClientId = clientId;
};

const withTimeout = async <T>(promise: Promise<T>, message: string): Promise<T> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), GOOGLE_SIGN_IN_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
};

const mapNativeResult = (result: SignInResult): GoogleAccountSession => ({
  userId: result.userId,
  email: result.email,
  displayName: result.displayName,
  imageUrl: result.imageUrl,
  idToken: result.idToken,
});

export const startGoogleAuth = async (intent: GoogleAuthIntent): Promise<GoogleAccountSession> => {
  if (isNativePlatform()) {
    await initializeNativeGoogleSignIn();
    if (intent === 'pin-reset') await GoogleSignIn.signOut().catch(() => undefined);
    const result = await withTimeout(
      GoogleSignIn.signIn(),
      'Google sign-in did not finish. Select the linked account and try again.',
    );
    return mapNativeResult(result);
  }

  localStorage.setItem(GOOGLE_AUTH_INTENT_KEY, intent);
  const { startWebGoogleSyncSignIn } = await import('../sync/webGoogleAuth');
  await startWebGoogleSyncSignIn();
  return new Promise<GoogleAccountSession>(() => undefined);
};

export const getPendingGoogleAuthIntent = (): GoogleAuthIntent | null => {
  const value = localStorage.getItem(GOOGLE_AUTH_INTENT_KEY);
  return value === 'pin-reset' || value === 'sync' ? value : null;
};

export const clearGoogleAuthIntent = (): void => localStorage.removeItem(GOOGLE_AUTH_INTENT_KEY);

export const signOutGoogleAuth = async (): Promise<void> => {
  clearGoogleAuthIntent();
  if (isNativePlatform()) {
    await initializeNativeGoogleSignIn();
    await GoogleSignIn.signOut().catch(() => undefined);
    return;
  }
  const { signOutWebGoogleSync } = await import('../sync/webGoogleAuth');
  await signOutWebGoogleSync().catch(() => undefined);
};
