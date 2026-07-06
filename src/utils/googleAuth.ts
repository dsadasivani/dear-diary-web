import { GoogleSignIn } from '@capawesome/capacitor-google-sign-in';
import type { SignInResult } from '@capawesome/capacitor-google-sign-in';
import { isNativePlatform } from '../platform';
import { nativeDriveBackupBridge } from '../platform/drive/nativeDriveBackupBridge';
import type { GoogleAccountIdentity, GoogleAccountSession, GoogleConnectionState } from '../types';

export type GoogleAuthIntent = 'backup' | 'pin-reset' | 'sync';

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

const initializeNativeGoogleSignIn = async (): Promise<void> => {
  const initializationKey = getGoogleWebClientId();
  if (nativeGoogleInitializationKey === initializationKey) return;

  await GoogleSignIn.initialize({
    clientId: getGoogleWebClientId(),
  });
  nativeGoogleInitializationKey = initializationKey;
};

const signInWithNativeGoogle = async (intent: GoogleAuthIntent): Promise<GoogleAccountSession> => {
  await initializeNativeGoogleSignIn();

  const result: SignInResult = await GoogleSignIn.signIn();
  let session: GoogleAccountSession = {
    userId: result.userId,
    email: result.email,
    displayName: result.displayName,
    imageUrl: result.imageUrl,
    accessToken: null,
    idToken: result.idToken,
  };

  if (intent === 'backup' || intent === 'sync') {
    if (!result.email) throw new Error('Google did not return an email address for the selected account.');
    const account: GoogleAccountIdentity = {
      userId: result.userId,
      email: result.email,
      displayName: result.displayName,
      linkedAt: Date.now(),
    };
    await nativeDriveBackupBridge.saveLinkedAccount(account);
    const authorization = await nativeDriveBackupBridge.authorize({ interactive: true });
    if (!authorization.authorized || !authorization.accessToken || !authorization.account) {
      throw new Error('Google did not grant Drive app data access.');
    }
    session = {
      userId: authorization.account.userId,
      email: authorization.account.email,
      displayName: authorization.account.displayName,
      imageUrl: result.imageUrl,
      accessToken: authorization.accessToken,
      idToken: result.idToken,
    };
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

export const getGoogleConnectionState = async (): Promise<GoogleConnectionState> => {
  if (!isNativePlatform()) {
    return { linked: false, authorized: false, reauthorizationRequired: false, account: null };
  }
  return nativeDriveBackupBridge.getConnectionState();
};

export const restoreGoogleDriveSession = async (interactive = false): Promise<GoogleAccountSession | null> => {
  if (!isNativePlatform()) return null;
  const authorization = await nativeDriveBackupBridge.authorize({ interactive });
  if (!authorization.authorized || !authorization.accessToken || !authorization.account) return null;
  const session: GoogleAccountSession = {
    userId: authorization.account.userId,
    email: authorization.account.email,
    displayName: authorization.account.displayName,
    imageUrl: null,
    accessToken: authorization.accessToken,
    idToken: null,
  };
  cachedDriveSession = session;
  return session;
};

export const clearCachedGoogleDriveSession = (): void => {
  cachedDriveSession = null;
};

export const signOutGoogleAuth = async (): Promise<void> => {
  localStorage.removeItem(GOOGLE_AUTH_INTENT_KEY);
  clearCachedGoogleDriveSession();

  if (!isNativePlatform()) return;

  try {
    await nativeDriveBackupBridge.disconnect();
    await initializeNativeGoogleSignIn();
    await GoogleSignIn.signOut();
  } catch (err) {
    console.warn('Native Google sign-out did not complete:', err);
  }
};
