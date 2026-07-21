import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CompanionApprovalPanel, { pairingCompatibilityError } from './CompanionApprovalPanel';

const mocks = vi.hoisted(() => ({
  getLocalSyncAccountState: vi.fn(),
  pullPending: vi.fn(),
  loadSyncSecrets: vi.fn(),
  restoreGoogleDriveSession: vi.fn(),
  resumePendingDeviceKeyRotation: vi.fn(),
  listPendingPairingSessions: vi.fn(),
  listAccountDevices: vi.fn(),
  listPendingSyncV2Pairings: vi.fn(),
  listSyncV2Devices: vi.fn(),
  resumePendingSyncV2DeviceRevocation: vi.fn(),
}));

vi.mock('../repositories', () => ({
  diaryRepository: {
    getLocalSyncAccountState: mocks.getLocalSyncAccountState,
  },
  eventSyncEngine: {
    pullPending: mocks.pullPending,
  },
}));

vi.mock('../sync/syncSecrets', () => ({ loadSyncSecrets: mocks.loadSyncSecrets }));
vi.mock('../utils/googleAuth', () => ({
  restoreGoogleDriveSession: mocks.restoreGoogleDriveSession,
}));
vi.mock('../sync/deviceKeyRotation', () => ({
  resumePendingDeviceKeyRotation: mocks.resumePendingDeviceKeyRotation,
  revokeDeviceWithKeyRotation: vi.fn(),
}));
vi.mock('../sync/companionPairing', () => ({ approveCompanionPairing: vi.fn() }));
vi.mock('../sync/v2/v2CompanionPairing', () => ({
  listPendingSyncV2Pairings: mocks.listPendingSyncV2Pairings,
  approveSyncV2CompanionPairing: vi.fn(),
}));
vi.mock('../sync/v2/v2DeviceManagement', () => ({
  listSyncV2Devices: mocks.listSyncV2Devices,
  resumePendingSyncV2DeviceRevocation: mocks.resumePendingSyncV2DeviceRevocation,
  revokeSyncV2Device: vi.fn(),
}));
vi.mock('../sync/config', () => ({
  createConfiguredSupabaseControlPlaneClient: () => ({
    listPendingPairingSessions: mocks.listPendingPairingSessions,
    listAccountDevices: mocks.listAccountDevices,
  }),
}));

describe('CompanionApprovalPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getLocalSyncAccountState.mockResolvedValue({
      accountId: 'account-1',
      deviceId: 'primary-1',
      deviceRole: 'primary_mobile',
    });
    mocks.loadSyncSecrets.mockResolvedValue({
      supabaseSession: { accessToken: 'token' },
      googleSession: null,
    });
    mocks.restoreGoogleDriveSession.mockResolvedValue(null);
    mocks.resumePendingDeviceKeyRotation.mockResolvedValue({ status: 'none' });
    mocks.listPendingPairingSessions.mockResolvedValue([]);
    mocks.listAccountDevices.mockResolvedValue([]);
    mocks.listPendingSyncV2Pairings.mockResolvedValue([]);
    mocks.listSyncV2Devices.mockResolvedValue([]);
    mocks.resumePendingSyncV2DeviceRevocation.mockResolvedValue('none');
  });

  it('shows active companions returned by device management', async () => {
    mocks.getLocalSyncAccountState.mockResolvedValue({
      accountId: 'v2-account',
      deviceId: 'primary-v2',
      deviceRole: 'primary_mobile',
      syncProtocolVersion: 2,
    });
    mocks.listSyncV2Devices.mockResolvedValue([
      {
        deviceId: 'web-v2',
        deviceRole: 'COMPANION',
        deviceStatus: 'ACTIVE',
        platform: 'web',
        encryptionPublicKey: 'public',
        registeredAt: '2026-07-15T00:00:00Z',
        lastSeenAt: '2026-07-15T00:00:00Z',
        lastAppVersion: null,
      },
    ]);

    const view = render(<CompanionApprovalPanel />);

    expect(await screen.findByText('Linked companions')).toBeInTheDocument();
    expect(screen.getByTitle('Revoke companion')).toBeInTheDocument();
    expect(mocks.listSyncV2Devices).toHaveBeenCalledWith('primary-v2');
    view.unmount();
  });

  it('routes a primary directly to secure pairing discovery', async () => {
    mocks.getLocalSyncAccountState.mockResolvedValue({
      accountId: 'v2-account',
      deviceId: 'primary-v2',
      deviceRole: 'primary_mobile',
      syncProtocolVersion: 2,
    });
    mocks.listPendingSyncV2Pairings.mockResolvedValue([
      {
        accountId: 'v2-account',
        pairingId: 'pairing-v2',
        requestedDeviceId: 'web-v2',
        requestedDeviceEncryptionPublicKey: 'public',
        platform: 'web',
        challenge: 'challenge',
        status: 'REQUESTED',
        keyEpoch: 1,
        keyPackageId: null,
        objectKey: null,
        sha256: null,
        sizeBytes: null,
        downloadUrl: null,
        downloadExpiresAt: null,
        upload: null,
        requestedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    ]);

    const view = render(<CompanionApprovalPanel />);

    expect(await screen.findByText('Web browser')).toBeInTheDocument();
    expect(screen.getByText('web')).toBeInTheDocument();
    expect(mocks.listPendingSyncV2Pairings).toHaveBeenCalledWith('primary-v2');
    expect(mocks.listPendingPairingSessions).not.toHaveBeenCalled();
    view.unmount();
  });

  it('loads companion requests when encrypted data synchronization is paused', async () => {
    mocks.pullPending.mockRejectedValue(new Error('Synchronization paused to protect local data.'));
    mocks.listPendingPairingSessions.mockResolvedValue([
      {
        id: 'pairing-1',
        accountId: 'account-1',
        requestedDisplayName: 'Writing laptop',
        requestedPlatform: 'web',
      },
    ]);

    const view = render(<CompanionApprovalPanel />);

    expect(await screen.findByText('Writing laptop')).toBeInTheDocument();
    expect(
      screen.queryByText('Synchronization paused to protect local data.'),
    ).not.toBeInTheDocument();
    expect(mocks.pullPending).not.toHaveBeenCalled();
    expect(mocks.listPendingPairingSessions).toHaveBeenCalledWith('primary-1');
    expect(mocks.listAccountDevices).toHaveBeenCalledWith('primary-1');

    await waitFor(() =>
      expect(screen.queryByText('Could not load companion requests.')).not.toBeInTheDocument(),
    );
    view.unmount();
  });

  it('rejects an outdated pairing request for a different account', () => {
    expect(
      pairingCompatibilityError(
        {
          accountId: 'v2-account',
          v1AccountId: 'v1-account',
          syncProtocolVersion: 2,
        },
        { accountId: 'v1-account' },
      ),
    ).toMatch(/outdated pairing request/);
  });

  it('accepts a pairing request belonging to the active protocol account', () => {
    expect(
      pairingCompatibilityError(
        {
          accountId: 'v2-account',
          v1AccountId: 'v1-account',
          syncProtocolVersion: 2,
        },
        { accountId: 'v2-account' },
      ),
    ).toBeNull();
  });
});
