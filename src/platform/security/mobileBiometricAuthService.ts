import type { SecureAuthService } from './SecureAuthService';
import { NativeBiometric } from '@capgo/capacitor-native-biometric';
import { BRAND } from '../../config/brand';

export class MobileBiometricAuthService implements SecureAuthService {
  async isAvailable(): Promise<boolean> {
    try {
      const result = await NativeBiometric.isAvailable({ useFallback: false });
      return result.isAvailable && result.strongBiometryIsAvailable;
    } catch (error) {
      console.warn('Native biometric availability check failed:', error);
      return false;
    }
  }

  async authenticate(): Promise<boolean> {
    try {
      await NativeBiometric.verifyIdentity({
        reason: `Unlock ${BRAND.name}`,
        title: BRAND.name,
        subtitle: 'Confirm fingerprint to unlock',
        description: 'Use your enrolled biometric credential to open your private space.',
        negativeButtonText: 'Use PIN',
        maxAttempts: 3,
      });
      return true;
    } catch (error) {
      console.warn('Native biometric authentication failed:', error);
      return false;
    }
  }

  async enroll(): Promise<{ credentialId: string; simulated?: boolean } | null> {
    const available = await this.isAvailable();
    if (!available) {
      return null;
    }

    const verified = await this.authenticate();
    if (!verified) {
      return null;
    }

    return { credentialId: 'native-biometric', simulated: false };
  }
}
