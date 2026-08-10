import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CompanionApprovalPanel from './CompanionApprovalPanel';

const mocks = vi.hoisted(() => ({
  getLocalSyncAccountState: vi.fn(),
  pullPending: vi.fn(),
  listPendingSyncV2Pairings: vi.fn(),
  approveSyncV2CompanionPairing: vi.fn(),
  listSyncV2Devices: vi.fn(),
  resumePendingSyncV2DeviceRevocation: vi.fn(),
  hasPrimaryRecoveryCredential: vi.fn(),
  revokeSyncV2Device: vi.fn(),
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
  approveSyncV2CompanionPairing: mocks.approveSyncV2CompanionPairing,
}));
vi.mock('../sync/v2/v2DeviceManagement', () => ({
  listSyncV2Devices: mocks.listSyncV2Devices,
  resumePendingSyncV2DeviceRevocation: mocks.resumePendingSyncV2DeviceRevocation,
  revokeSyncV2Device: mocks.revokeSyncV2Device,
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
    mocks.pullPending.mockResolvedValue(undefined);
    mocks.revokeSyncV2Device.mockResolvedValue(undefined);
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

  it('shows only the newest request when an older service returns duplicate browser pairings', async () => {
    const pairing = (pairingId: string, requestedAt: string) => ({
      accountId: 'v2-account',
      pairingId,
      requestedDeviceId: `web-${pairingId}`,
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
      requestedAt,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    mocks.listPendingSyncV2Pairings.mockResolvedValue([
      pairing('older', '2026-08-09T10:00:00Z'),
      pairing('newer', '2026-08-09T10:01:00Z'),
    ]);

    render(<CompanionApprovalPanel />);

    const codeInput = await screen.findByLabelText('Pairing code for Web browser');
    expect(screen.getAllByLabelText('Pairing code for Web browser')).toHaveLength(1);
    fireEvent.change(codeInput, { target: { value: '12345678' } });
    fireEvent.click(screen.getByTitle('Approve companion'));
    await waitFor(() =>
      expect(mocks.approveSyncV2CompanionPairing).toHaveBeenCalledWith(
        expect.objectContaining({ pairingId: 'newer' }),
        '12345678',
      ),
    );
  });

  it('asks existing primaries to finish the security upgrade', async () => {
    mocks.hasPrimaryRecoveryCredential.mockResolvedValue(false);
    render(<CompanionApprovalPanel />);
    expect(await screen.findByText('Finish security upgrade')).toBeInTheDocument();
  });

  it('dismisses confirmation immediately and completes device removal in the background', async () => {
    let finishRevocation!: () => void;
    mocks.revokeSyncV2Device.mockImplementation(
      () => new Promise<void>((resolve) => (finishRevocation = resolve)),
    );
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

    render(<CompanionApprovalPanel />);
    fireEvent.click(await screen.findByTitle('Remove device'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Device' }));

    await waitFor(() => expect(screen.queryByText('Remove device?')).not.toBeInTheDocument());
    expect(screen.getByText('Removal in progress')).toBeInTheDocument();
    expect(
      screen.getByText('Removing this device securely. You can continue using the app.'),
    ).toBeInTheDocument();
    await waitFor(() => expect(mocks.revokeSyncV2Device).toHaveBeenCalledWith('web-v2'));

    finishRevocation();
    await screen.findByText('Device removed and the encrypted account key was rotated.');
  });

  it('makes a failed background removal retryable', async () => {
    mocks.revokeSyncV2Device.mockRejectedValue(new Error('Network unavailable.'));
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

    render(<CompanionApprovalPanel />);
    fireEvent.click(await screen.findByTitle('Remove device'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Device' }));

    expect(await screen.findByText('Network unavailable.')).toBeInTheDocument();
    expect(screen.getByTitle('Remove device')).toBeEnabled();
  });
});
