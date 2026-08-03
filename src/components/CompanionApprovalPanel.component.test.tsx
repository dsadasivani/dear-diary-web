import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CompanionApprovalPanel from './CompanionApprovalPanel';

const mocks = vi.hoisted(() => ({
  getLocalSyncAccountState: vi.fn(),
  pullPending: vi.fn(),
  listPendingSyncV2Pairings: vi.fn(),
  listSyncV2Devices: vi.fn(),
  resumePendingSyncV2DeviceRevocation: vi.fn(),
  hasPrimaryRecoveryCredential: vi.fn(),
}));

vi.mock('../repositories', () => ({
  diaryRepository: {
    getLocalSyncAccountState: mocks.getLocalSyncAccountState,
  },
  eventSyncEngine: {
    pullPending: mocks.pullPending,
  },
}));

vi.mock('../sync/v2/v2CompanionPairing', () => ({
  listPendingSyncV2Pairings: mocks.listPendingSyncV2Pairings,
  approveSyncV2CompanionPairing: vi.fn(),
}));
vi.mock('../sync/v2/v2DeviceManagement', () => ({
  listSyncV2Devices: mocks.listSyncV2Devices,
  resumePendingSyncV2DeviceRevocation: mocks.resumePendingSyncV2DeviceRevocation,
  revokeSyncV2Device: vi.fn(),
  hasPrimaryRecoveryCredential: mocks.hasPrimaryRecoveryCredential,
  enrollPrimaryRecoveryCredential: vi.fn(),
}));

describe('CompanionApprovalPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getLocalSyncAccountState.mockResolvedValue({
      accountId: 'account-1',
      deviceId: 'primary-1',
      deviceRole: 'primary_mobile',
      syncProtocolVersion: 2,
    });
    mocks.listPendingSyncV2Pairings.mockResolvedValue([]);
    mocks.listSyncV2Devices.mockResolvedValue([]);
    mocks.resumePendingSyncV2DeviceRevocation.mockResolvedValue('none');
    mocks.hasPrimaryRecoveryCredential.mockResolvedValue(true);
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
    expect(screen.getByTitle('Remove device')).toBeInTheDocument();
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
    view.unmount();
  });

  it('asks existing primaries to finish the security upgrade', async () => {
    mocks.hasPrimaryRecoveryCredential.mockResolvedValue(false);
    render(<CompanionApprovalPanel />);
    expect(await screen.findByText('Finish security upgrade')).toBeInTheDocument();
  });
});
