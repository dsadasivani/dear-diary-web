import type { SecureAuthService } from './SecureAuthService';
import {
  authenticateLocalPasskey,
  isWebAuthnSupported,
  registerLocalPasskey,
} from '../../utils/webauthn';

export class WebAuthnSecureAuthService implements SecureAuthService {
  async isAvailable(): Promise<boolean> {
    return isWebAuthnSupported();
  }

  async authenticate(credentialId?: string): Promise<boolean> {
    return authenticateLocalPasskey(credentialId);
  }

  async enroll(userName: string): Promise<{ credentialId: string; simulated?: boolean } | null> {
    return registerLocalPasskey(userName);
  }
}
