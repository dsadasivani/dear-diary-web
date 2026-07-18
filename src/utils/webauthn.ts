/**
 * WebAuthn Passkeys Utility
 * Enables standards-compliant, secure biometric authentication using Touch ID, Face ID, or Windows Hello.
 */
// Helper to convert base64url string to Uint8Array
export function base64ToBytes(base64: string): Uint8Array {
  const normalized = base64.replace(/-/g, '+').replace(/_/g, '/');
  const binaryString = window.atob(normalized);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

// Helper to convert Uint8Array to base64url string
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/**
 * Checks if the browser and current context support WebAuthn
 */
export async function isWebAuthnSupported(): Promise<boolean> {
  const hasApi = !!(window.PublicKeyCredential && navigator.credentials);
  if (!hasApi) return false;

  try {
    // Check if platform authenticator (TouchID/FaceID) is available
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch (e) {
    return false;
  }
}

/**
 * Returns true if WebAuthn is likely to fail due to context (e.g. HTTP, iframe restrictions)
 */
export function isContextRestricted(): boolean {
  // Insecure context or inside an iframe with sandboxed permissions
  const isInsecure = !window.isSecureContext;
  const isIframe = window.self !== window.top;
  return isInsecure || isIframe;
}

/**
 * Enroll a new WebAuthn Passkey (Touch ID, Face ID, Windows Hello)
 */
export async function registerLocalPasskey(
  username: string = 'dear.diary.user',
): Promise<{ credentialId: string; isSimulated: boolean }> {
  if (!window.PublicKeyCredential || !navigator.credentials) {
    throw new Error(
      'WebAuthn is not supported in this browser environment. Ensure you are using HTTPS.',
    );
  }

  const challenge = new Uint8Array(32);
  window.crypto.getRandomValues(challenge);
  const userId = new Uint8Array(16);
  window.crypto.getRandomValues(userId);

  const rpId = window.location.hostname || 'localhost';

  const creationOptions: PublicKeyCredentialCreationOptions = {
    challenge,
    rp: {
      name: 'Dear Diary Private Sanctuary',
      id: rpId,
    },
    user: {
      id: userId,
      name: username,
      displayName: 'Dear Diary User',
    },
    pubKeyCredParams: [
      { type: 'public-key', alg: -7 }, // ES256
      { type: 'public-key', alg: -257 }, // RS256
    ],
    authenticatorSelection: {
      authenticatorAttachment: 'platform',
      userVerification: 'required',
      residentKey: 'required',
    },
    timeout: 60000,
  };

  try {
    const credential = (await navigator.credentials.create({
      publicKey: creationOptions,
    })) as PublicKeyCredential;

    if (!credential) {
      throw new Error('Verification failed: No credential returned.');
    }

    const rawId = new Uint8Array(credential.rawId);
    const credentialIdB64 = bytesToBase64(rawId);

    return {
      credentialId: credentialIdB64,
      isSimulated: false,
    };
  } catch (error: any) {
    console.warn(
      'Real WebAuthn enrollment failed or was cancelled. Error name:',
      error?.name,
      error?.message,
    );

    // If it is a real permission issue (like inside iframe) or user cancelled, let the caller know
    if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
      throw error;
    }

    throw new Error(error?.message || 'Biometric authenticator registration failed.');
  }
}

/**
 * Authenticates using a previously registered WebAuthn Passkey
 */
export async function authenticateLocalPasskey(allowedCredentialId?: string): Promise<boolean> {
  if (!window.PublicKeyCredential || !navigator.credentials) {
    throw new Error('WebAuthn is not supported in this browser environment.');
  }

  const challenge = new Uint8Array(32);
  window.crypto.getRandomValues(challenge);

  const rpId = window.location.hostname || 'localhost';

  const requestOptions: PublicKeyCredentialRequestOptions = {
    challenge,
    rpId,
    userVerification: 'required',
    timeout: 60000,
  };

  if (allowedCredentialId) {
    try {
      const credIdBytes = base64ToBytes(allowedCredentialId);
      requestOptions.allowCredentials = [
        {
          type: 'public-key',
          id: credIdBytes,
        },
      ];
    } catch (e) {
      console.warn('Could not parse allowedCredentialId:', e);
    }
  }

  try {
    const assertion = await navigator.credentials.get({
      publicKey: requestOptions,
    });
    return !!assertion;
  } catch (error: any) {
    console.warn('Real WebAuthn authentication failed or was cancelled:', error);
    throw error;
  }
}
