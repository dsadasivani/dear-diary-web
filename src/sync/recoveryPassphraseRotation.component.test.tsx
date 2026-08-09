import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SecurityConfig } from '../types';

const mocks = vi.hoisted(() => ({
  storedSecrets: null as any,
  tokenProvider: null as null | (() => Promise<string>),
  getProtocol: vi.fn(),
  initiateKeyPackage: vi.fn(),
  registerKeyPackage: vi.fn(),
  upload: vi.fn(),
  validateRecoveryPassphrase: vi.fn(),
  wrapAccountRootKeyForRecovery: vi.fn(),
  encodeRecoveryKeyPackage: vi.fn(),
  loadSyncSecrets: vi.fn(),
  saveSyncSecrets: vi.fn(),
  withPrimaryRecoveryCredential: vi.fn(),
}));

vi.mock('./config', () => ({
  createConfiguredSyncV2ApiClient: (tokenProvider: () => Promise<string>) => {
    mocks.tokenProvider = tokenProvider;
    return {
      getProtocol: mocks.getProtocol,
      initiateKeyPackage: mocks.initiateKeyPackage,
      registerKeyPackage: mocks.registerKeyPackage,
    };
  },
}));

vi.mock('./e2eeKeyPackage', () => ({
  validateRecoveryPassphrase: mocks.validateRecoveryPassphrase,
  getAccountRootKeyForEpoch: (secrets: any, epoch: number) =>
    secrets.accountRootKeys?.[epoch] || secrets.accountRootKey,
  wrapAccountRootKeyForRecovery: mocks.wrapAccountRootKeyForRecovery,
  encodeRecoveryKeyPackage: mocks.encodeRecoveryKeyPackage,
}));

vi.mock('./syncSecrets', () => ({
  getAccountRootKeyForEpoch: (secrets: any, epoch: number) =>
    secrets.accountRootKeys?.[epoch] || secrets.accountRootKey,
  loadSyncSecrets: mocks.loadSyncSecrets,
  saveSyncSecrets: mocks.saveSyncSecrets,
  withPrimaryRecoveryCredential: mocks.withPrimaryRecoveryCredential,
}));

vi.mock('./v2/operation/BoundedObjectTransfer', () => ({
  BoundedObjectTransfer: class {
    upload = mocks.upload;
  },
}));

import { rotateRecoveryPassphrase } from './recoveryPassphraseRotation';

const state = {
  accountId: 'account-1',
  syncProtocolVersion: 2 as const,
  deviceId: 'primary-1',
  deviceRole: 'primary_mobile' as const,
  googleUserId: 'google-1',
  googleEmail: 'writer@example.com',
  devicePublicKey: 'public-key',
  currentSyncSequence: 3,
  keyEpoch: 2,
  linkedAt: 1,
};

const security: SecurityConfig = {
  isPinCreated: true,
  pinHash: 'hash',
  pinSalt: 'salt',
  isBiometricsEnabled: false,
  isLocked: false,
  linkedGoogleUserId: 'google-1',
  linkedGoogleEmail: 'writer@example.com',
};

const googleSession = {
  userId: 'google-1',
  email: 'writer@example.com',
  displayName: 'Writer',
  idToken: 'fresh-google-token',
};

const supabaseSession = {
  accessToken: 'fresh-supabase-token',
  refreshToken: 'fresh-refresh-token',
};

const repository = {
  getLocalSyncAccountState: vi.fn(async () => state),
  getSecurityConfig: vi.fn(async () => security),
};

const syncEngine = { pullPending: vi.fn(async () => undefined) };

describe('Google-verified recovery passphrase rotation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.storedSecrets = {
      version: 2,
      accountId: 'account-1',
      accountRootKey: new Uint8Array(32).fill(2),
      accountRootKeys: {
        1: new Uint8Array(32).fill(1),
        2: new Uint8Array(32).fill(2),
      },
      devicePrivateKeyJwk: '{}',
      supabaseSession: { accessToken: 'old-token', refreshToken: 'old-refresh' },
      googleSession,
      primaryRecoveryCredential: {
        version: 1,
        passphrase: '11111111',
        capturedAt: 1,
      },
    };
    mocks.loadSyncSecrets.mockImplementation(async () => mocks.storedSecrets);
    mocks.saveSyncSecrets.mockImplementation(async (value) => {
      mocks.storedSecrets = value;
    });
    mocks.withPrimaryRecoveryCredential.mockImplementation((value, passphrase) => ({
      ...value,
      primaryRecoveryCredential: { version: 1, passphrase, capturedAt: 2 },
    }));
    mocks.wrapAccountRootKeyForRecovery.mockResolvedValue({ packageKind: 'root_key' });
    mocks.encodeRecoveryKeyPackage.mockReturnValue(new Uint8Array([1, 2, 3]));
    mocks.getProtocol.mockResolvedValue({ maximumSnapshotBytes: 1024 });
    mocks.initiateKeyPackage.mockResolvedValue({
      upload: { objectKey: 'recovery-key', uploadUrl: 'memory://upload' },
    });
    mocks.registerKeyPackage.mockResolvedValue({});
    mocks.upload.mockResolvedValue(undefined);
  });

  it('uses fresh authorization and stores the new credential after registration', async () => {
    await rotateRecoveryPassphrase({
      newPassphrase: '22222222',
      googleSession,
      supabaseSession,
      repository: repository as any,
      syncEngine: syncEngine as any,
    });

    expect(syncEngine.pullPending).toHaveBeenCalledOnce();
    expect(await mocks.tokenProvider?.()).toBe('fresh-supabase-token');
    expect(mocks.registerKeyPackage).toHaveBeenCalledWith(expect.any(String), 'primary-1');
    expect(mocks.storedSecrets.primaryRecoveryCredential.passphrase).toBe('22222222');
    expect(mocks.saveSyncSecrets).toHaveBeenCalledTimes(2);
  });

  it('rejects a different Google subject before changing local or remote state', async () => {
    await expect(
      rotateRecoveryPassphrase({
        newPassphrase: '22222222',
        googleSession: { ...googleSession, userId: 'google-2' },
        supabaseSession,
        repository: repository as any,
        syncEngine: syncEngine as any,
      }),
    ).rejects.toThrow(/Verify writer@example\.com with Google/);

    expect(mocks.saveSyncSecrets).not.toHaveBeenCalled();
    expect(mocks.initiateKeyPackage).not.toHaveBeenCalled();
  });

  it('rejects a Google result without a fresh ID token', async () => {
    await expect(
      rotateRecoveryPassphrase({
        newPassphrase: '22222222',
        googleSession: { ...googleSession, idToken: null },
        supabaseSession,
        repository: repository as any,
        syncEngine: syncEngine as any,
      }),
    ).rejects.toThrow(/Verify writer@example\.com with Google/);

    expect(mocks.saveSyncSecrets).not.toHaveBeenCalled();
  });

  it('keeps the old recovery credential when remote registration fails', async () => {
    mocks.registerKeyPackage.mockRejectedValueOnce(new Error('registration failed'));

    await expect(
      rotateRecoveryPassphrase({
        newPassphrase: '22222222',
        googleSession,
        supabaseSession,
        repository: repository as any,
        syncEngine: syncEngine as any,
      }),
    ).rejects.toThrow(/registration failed/);

    expect(mocks.storedSecrets.primaryRecoveryCredential.passphrase).toBe('11111111');
    expect(mocks.withPrimaryRecoveryCredential).not.toHaveBeenCalled();
  });
});
