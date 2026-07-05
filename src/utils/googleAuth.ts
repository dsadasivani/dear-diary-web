import { GoogleSignIn } from '@capawesome/capacitor-google-sign-in';
import { isNativePlatform } from '../platform';
import type { GoogleAccountSession } from '../types';

export type GoogleAuthIntent = 'backup' | 'pin-reset';

const GOOGLE_AUTH_INTENT_KEY = 'deardiary_google_auth_intent';
const DRIVE_APPDATA_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
let nativeGoogleInitializationKey = '';
let cachedDriveSession: GoogleAccountSession | null = null;

export { DRIVE_APPDATA_SCOPE };

const getGoogleWebClientId = (): string => {
  const clientId = (import.meta.env.VITE_GOOGLE_WEB_CLIENT_ID as string | undefined)?.trim();
  if (!clientId) {
    throw new Error(
      'Mobile Google sign-in is missing VITE_GOOGLE_WEB_CLIENT_ID. Add the Google Cloud OAuth Web application client ID to .env, then rebuild and reinstall the APK.'
    );
  }
  return clientId;
};

const getScopesForIntent = (intent: GoogleAuthIntent): string[] => (
  intent === 'backup' ? [DRIVE_APPDATA_SCOPE] : []
);

const initializeNativeGoogleSignIn = async (intent: GoogleAuthIntent): Promise<void> => {
  const scopes = getScopesForIntent(intent);
  const initializationKey = `${getGoogleWebClientId()}|${scopes.join(' ')}`;
  if (nativeGoogleInitializationKey === initializationKey) return;

  await GoogleSignIn.initialize({
    clientId: getGoogleWebClientId(),
    scopes,
  });
  nativeGoogleInitializationKey = initializationKey;
};

const signInWithNativeGoogle = async (intent: GoogleAuthIntent): Promise<GoogleAccountSession> => {
  await initializeNativeGoogleSignIn(intent);

  const result = await GoogleSignIn.signIn();
  if (intent === 'backup' && !result.accessToken) {
    throw new Error('Google did not return Drive access. Reconnect and approve the Google Drive app data permission.');
  }

  const session: GoogleAccountSession = {
    userId: result.userId,
    email: result.email,
    displayName: result.displayName,
    accessToken: result.accessToken,
  };

  if (intent === 'backup') {
    cachedDriveSession = session;
  }

  return session;
};

export const startGoogleAuth = async (intent: GoogleAuthIntent): Promise<GoogleAccountSession> => {
  localStorage.removeItem(GOOGLE_AUTH_INTENT_KEY);

  if (isNativePlatform()) {
    return signInWithNativeGoogle(intent);
  }

  throw new Error('Google Drive backup is available in the native mobile app. Use the local encrypted export on web.');
};

export const clearGoogleAuthIntent = (): void => {
  localStorage.removeItem(GOOGLE_AUTH_INTENT_KEY);
};

export const getCachedGoogleDriveSession = (): GoogleAccountSession | null => cachedDriveSession;

export const clearCachedGoogleDriveSession = (): void => {
  cachedDriveSession = null;
};

export const signOutGoogleAuth = async (): Promise<void> => {
  localStorage.removeItem(GOOGLE_AUTH_INTENT_KEY);
  clearCachedGoogleDriveSession();

  if (!isNativePlatform()) return;

  try {
    await initializeNativeGoogleSignIn('backup');
    await GoogleSignIn.signOut();
  } catch (err) {
    console.warn('Native Google sign-out did not complete:', err);
  }
};
