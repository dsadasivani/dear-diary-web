import { isNativePlatform } from '../platform';
import type { SecureAuthService } from './SecureAuthService';
import { MobileBiometricAuthService } from './mobileBiometricAuthService';
import { WebAuthnSecureAuthService } from './webAuthnSecureAuthService';

export type { SecureAuthService } from './SecureAuthService';

export const secureAuthService: SecureAuthService = isNativePlatform()
  ? new MobileBiometricAuthService()
  : new WebAuthnSecureAuthService();
