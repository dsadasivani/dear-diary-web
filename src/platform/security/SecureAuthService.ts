export interface SecureAuthService {
  isAvailable(): Promise<boolean>;
  authenticate(credentialId?: string): Promise<boolean>;
  enroll(userName: string): Promise<{ credentialId: string; simulated?: boolean } | null>;
}
