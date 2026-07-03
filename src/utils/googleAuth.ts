import {
  GoogleAuthProvider,
  signInWithCredential,
  signInWithPopup,
  signOut as firebaseSignOut,
} from 'firebase/auth';
import type { UserCredential } from 'firebase/auth';
import { GoogleSignIn } from '@capawesome/capacitor-google-sign-in';
import { isNativePlatform } from '../platform';
import { auth } from './firebase';

export type GoogleAuthIntent = 'sync' | 'pin-reset';

const GOOGLE_AUTH_INTENT_KEY = 'deardiary_google_auth_intent';
let isNativeGoogleInitialized = false;

const createGoogleProvider = (): GoogleAuthProvider => {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  return provider;
};

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
  if (isNativeGoogleInitialized) return;

  await GoogleSignIn.initialize({
    clientId: getGoogleWebClientId(),
  });
  isNativeGoogleInitialized = true;
};

const signInWithNativeGoogle = async (): Promise<UserCredential> => {
  await initializeNativeGoogleSignIn();

  const result = await GoogleSignIn.signIn();
  if (!result.idToken) {
    throw new Error('Google did not return an ID token. Check the Android OAuth client package name and SHA-1 fingerprint.');
  }

  const credential = GoogleAuthProvider.credential(result.idToken);
  return signInWithCredential(auth, credential);
};

export const startGoogleAuth = async (_intent: GoogleAuthIntent): Promise<UserCredential> => {
  localStorage.removeItem(GOOGLE_AUTH_INTENT_KEY);

  if (isNativePlatform()) {
    return signInWithNativeGoogle();
  }

  return signInWithPopup(auth, createGoogleProvider());
};

export const clearGoogleAuthIntent = (): void => {
  localStorage.removeItem(GOOGLE_AUTH_INTENT_KEY);
};

export const signOutGoogleAuth = async (): Promise<void> => {
  localStorage.removeItem(GOOGLE_AUTH_INTENT_KEY);
  await firebaseSignOut(auth);

  if (!isNativePlatform()) return;

  try {
    await initializeNativeGoogleSignIn();
    await GoogleSignIn.signOut();
  } catch (err) {
    console.warn('Native Google sign-out did not complete:', err);
  }
};
