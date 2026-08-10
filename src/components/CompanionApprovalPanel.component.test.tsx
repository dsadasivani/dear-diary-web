import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CompanionApprovalPanel from './CompanionApprovalPanel';

const mocks = vi.hoisted(() => ({
  getLocalSyncAccountState: vi.fn(),
  pullPending: vi.fn(),
  listPendingSyncPairings: vi.fn(),
  approveSyncCompanionPairing: vi.fn(),
  listSyncDevices: vi.fn(),
  resumePendingSyncDeviceRevocation: vi.fn(),
  hasPrimaryRecoveryCredential: vi.fn(),
  revokeSyncDevice: vi.fn(),
}));

vi.mock('../repositories', () => ({
  diaryRepository: {
    getLocalSyncAccountState: mocks.getLocalSyncAccountState,
  },
  eventSyncEngine: {
    pullPending: mocks.pullPending,
  },
}));

vi.mock('../sync/core/companionPairing', () => ({
  listPendingSyncPairings: mocks.listPendingSyncPairings,
  approveSyncCompanionPairing: mocks.approveSyncCompanionPairing,
}));
vi.mock('../sync/core/deviceManagement', () => ({
  listSyncDevices: mocks.listSyncDevices,
  resumePendingSyncDeviceRevocation: mocks.resumePendingSyncDeviceRevocation,
  revokeSyncDevice: mocks.revokeSyncDevice,
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
    mocks.listPendingSyncPairings.mockResolvedValue([]);
    mocks.listSyncDevices.mockResolvedValue([]);
    mocks.resumePendingSyncDeviceRevocation.mockResolvedValue('none');
    mocks.hasPrimaryRecoveryCredential.mockResolvedValue(true);
    mocks.pullPending.mockResolvedValue(undefined);
    mocks.revokeSyncDevice.mockResolvedValue(undefined);
  });

  it('shows active companions returned by device management', async () => {
    mocks.getLocalSyncAccountState.mockResolvedValue({
      accountId: 'v2-account',
      deviceId: 'primary-v2',
      deviceRole: 'primary_mobile',
      syncProtocolVersion: 2,
    });
    mocks.listSyncDevices.mockResolvedValue([
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
    expect(mocks.listSyncDevices).toHaveBeenCalledWith('primary-v2');
    view.unmount();
  });

  it('routes a primary directly to secure pairing discovery', async () => {
    mocks.getLocalSyncAccountState.mockResolvedValue({
      accountId: 'v2-account',
      deviceId: 'primary-v2',
      deviceRole: 'primary_mobile',
      syncProtocolVersion: 2,
    });
    mocks.listPendingSyncPairings.mockResolvedValue([
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
    expect(mocks.listPendingSyncPairings).toHaveBeenCalledWith('primary-v2');
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
    mocks.listPendingSyncPairings.mockResolvedValue([
      pairing('older', '2026-08-09T10:00:00Z'),
      pairing('newer', '2026-08-09T10:01:00Z'),
    ]);

    render(<CompanionApprovalPanel />);

    const codeInput = await screen.findByLabelText('Pairing code for Web browser');
    expect(screen.getAllByLabelText('Pairing code for Web browser')).toHaveLength(1);
    fireEvent.change(codeInput, { target: { value: '12345678' } });
    fireEvent.click(screen.getByTitle('Approve companion'));
    await waitFor(() =>
      expect(mocks.approveSyncCompanionPairing).toHaveBeenCalledWith(
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
    mocks.revokeSyncDevice.mockImplementation(
      () => new Promise<void>((resolve) => (finishRevocation = resolve)),
    );
    mocks.listSyncDevices.mockResolvedValue([
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
    await waitFor(() => expect(mocks.revokeSyncDevice).toHaveBeenCalledWith('web-v2'));

    finishRevocation();
    await screen.findByText('Device removed and the encrypted account key was rotated.');
  });

  it('makes a failed background removal retryable', async () => {
    mocks.revokeSyncDevice.mockRejectedValue(new Error('Network unavailable.'));
    mocks.listSyncDevices.mockResolvedValue([
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
