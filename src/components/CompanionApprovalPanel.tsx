import { useEffect, useRef, useState } from 'react';
import {
  Check,
  Link as Link2,
  RefreshDouble as LoaderCircle,
  Computer as Monitor,
  Refresh as RefreshCw,
  ShieldCheck,
  Trash as Trash2,
} from 'iconoir-react';
import { diaryRepository, eventSyncEngine } from '../repositories';
import type { SyncV2Device, SyncV2Pairing } from '../sync/v2/api/SyncV2ApiTypes';
import {
  approveSyncV2CompanionPairing,
  listPendingSyncV2Pairings,
} from '../sync/v2/v2CompanionPairing';
import {
  enrollPrimaryRecoveryCredential,
  hasPrimaryRecoveryCredential,
  listSyncV2Devices,
  resumePendingSyncV2DeviceRevocation,
  revokeSyncV2Device,
} from '../sync/v2/v2DeviceManagement';
import { BottomSheet } from './ui/BottomSheet';

export default function CompanionApprovalPanel() {
  const [sessions, setSessions] = useState<SyncV2Pairing[]>([]);
  const [devices, setDevices] = useState<SyncV2Device[]>([]);
  const [isPrimary, setIsPrimary] = useState<boolean | null>(null);
  const [securityUpgradeRequired, setSecurityUpgradeRequired] = useState(false);
  const [upgradePassphrase, setUpgradePassphrase] = useState('');
  const [isUpgrading, setIsUpgrading] = useState(false);
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [workingId, setWorkingId] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [revocationTarget, setRevocationTarget] = useState<SyncV2Device | null>(null);
  const revocationInFlightRef = useRef(false);

  const refresh = async (showLoading = true) => {
    if (revocationInFlightRef.current) return;
    if (showLoading) setLoading(true);
    try {
      const state = await diaryRepository.getLocalSyncAccountState();
      if (!state || state.syncProtocolVersion !== 2 || state.deviceRole !== 'primary_mobile') {
        setIsPrimary(false);
        return;
      }
      setIsPrimary(true);
      const credentialReady = await hasPrimaryRecoveryCredential();
      setSecurityUpgradeRequired(!credentialReady);
      const resumed = await resumePendingSyncV2DeviceRevocation();
      if (resumed === 'completed') setMessage('Pending device removal completed safely.');
      const [pendingPairings, accountDevices] = await Promise.all([
        listPendingSyncV2Pairings(state.deviceId),
        listSyncV2Devices(state.deviceId),
      ]);
      setSessions(pendingPairings);
      setDevices(
        accountDevices.filter(
          (device) => device.deviceRole === 'COMPANION' && device.deviceStatus === 'ACTIVE',
        ),
      );
    } catch (refreshError: any) {
      setError(refreshError?.message || 'Could not load linked devices.');
    } finally {
      if (showLoading) setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(false), 5_000);
    return () => window.clearInterval(timer);
  }, []);

  if (isPrimary !== true) return null;

  const approve = async (session: SyncV2Pairing) => {
    const pairingCode = (codes[session.pairingId] || '').trim();
    if (pairingCode.length !== 8) {
      setError('Enter the 8-digit code shown in the companion browser.');
      return;
    }
    setWorkingId(session.pairingId);
    setError('');
    try {
      await approveSyncV2CompanionPairing(session, pairingCode);
      setMessage('Web browser approved. It is restoring the encrypted diary.');
      setCodes((current) => ({ ...current, [session.pairingId]: '' }));
      await refresh();
    } catch (approvalError: any) {
      setError(approvalError?.message || 'Companion approval failed.');
    } finally {
      setWorkingId('');
    }
  };

  const finishSecurityUpgrade = async () => {
    setIsUpgrading(true);
    setError('');
    try {
      await enrollPrimaryRecoveryCredential(upgradePassphrase);
      setUpgradePassphrase('');
      setSecurityUpgradeRequired(false);
      setMessage('Security upgrade finished. Linked devices can now be removed safely.');
    } catch (upgradeError: any) {
      setError(upgradeError?.message || 'Could not finish the security upgrade.');
    } finally {
      setIsUpgrading(false);
    }
  };

  const revoke = () => {
    if (!revocationTarget || revocationInFlightRef.current) return;
    const targetDeviceId = revocationTarget.deviceId;
    revocationInFlightRef.current = true;
    setWorkingId(targetDeviceId);
    setRevocationTarget(null);
    setError('');
    setMessage('Removing this device securely. You can continue using the app.');

    void (async () => {
      let completed = false;
      try {
        await eventSyncEngine.pullPending();
        await revokeSyncV2Device(targetDeviceId);
        completed = true;
        setMessage('Device removed and the encrypted account key was rotated.');
      } catch (revokeError: any) {
        setMessage('');
        setError(
          revokeError?.message || 'Device removal could not finish. Tap Remove Device to retry.',
        );
      } finally {
        setWorkingId('');
        revocationInFlightRef.current = false;
        if (completed) void refresh(false);
      }
    })();
  };

  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-brand-border bg-brand-card-bg p-5 journal-shadow">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="rounded-lg bg-brand-sage/10 p-2.5 text-brand-sage">
            <Link2 className="h-4 w-4" />
          </span>
          <div>
            <h3 className="text-sm font-bold text-brand-plum dark:text-brand-text">
              Companion Devices
            </h3>
            <p className="text-xs text-brand-sage">Approve and manage linked browsers.</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-brand-border text-brand-sage disabled:opacity-50"
          title="Refresh devices"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {securityUpgradeRequired && (
        <div className="rounded-2xl border border-brand-pink/25 bg-brand-pink/5 p-4">
          <div className="flex items-start gap-3">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-brand-pink" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-brand-plum dark:text-brand-text">
                Finish security upgrade
              </p>
              <p className="mt-1 text-xs leading-relaxed text-brand-text-muted">
                Confirm your recovery passphrase once so this phone can safely rotate keys when you
                remove a linked device.
              </p>
              <div className="mt-3 flex gap-2">
                <input
                  type="password"
                  value={upgradePassphrase}
                  onChange={(event) => setUpgradePassphrase(event.target.value)}
                  placeholder="Recovery passphrase"
                  aria-label="Recovery passphrase for security upgrade"
                  className="min-w-0 flex-1 rounded-xl border border-brand-border bg-brand-bg px-3 py-2 text-sm text-brand-plum outline-none focus:border-brand-pink"
                />
                <button
                  type="button"
                  onClick={() => void finishSecurityUpgrade()}
                  disabled={!upgradePassphrase || isUpgrading}
                  className="rounded-xl bg-brand-plum px-3 py-2 text-xs font-bold text-white disabled:opacity-40"
                >
                  {isUpgrading ? 'Checking…' : 'Finish'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {sessions.map((session) => (
        <div
          key={session.pairingId}
          className="flex flex-col gap-3 border-t border-brand-border pt-3"
        >
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-bold text-brand-plum dark:text-brand-text">Web browser</p>
              <p className="text-xs uppercase text-brand-text-muted">{session.platform}</p>
            </div>
            <ShieldCheck className="h-4 w-4 text-brand-sage" />
          </div>
          <div className="flex gap-2">
            <input
              inputMode="numeric"
              maxLength={8}
              value={codes[session.pairingId] || ''}
              onChange={(event) =>
                setCodes((current) => ({
                  ...current,
                  [session.pairingId]: event.target.value.replace(/\D/g, '').slice(0, 8),
                }))
              }
              className="min-w-0 flex-1 rounded-lg border border-brand-border bg-brand-bg px-3 py-2 font-mono text-sm tracking-widest text-brand-plum outline-none focus:border-brand-pink"
              placeholder="8-digit code"
              aria-label="Pairing code for Web browser"
            />
            <button
              type="button"
              onClick={() => void approve(session)}
              disabled={
                workingId === session.pairingId || (codes[session.pairingId] || '').length !== 8
              }
              className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-sage text-white disabled:opacity-40"
              title="Approve companion"
            >
              {workingId === session.pairingId ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : (
                <Check className="h-4 w-4" />
              )}
            </button>
          </div>
        </div>
      ))}

      {devices.length > 0 && (
        <div className="flex flex-col gap-2 border-t border-brand-border pt-3">
          <p className="text-xs font-bold uppercase text-brand-sage">Linked companions</p>
          {devices.map((device) => (
            <div key={device.deviceId} className="flex items-center justify-between gap-3 py-1">
              <div className="flex min-w-0 items-center gap-2">
                <Monitor className="h-4 w-4 shrink-0 text-brand-sage" />
                <div className="min-w-0">
                  <p className="truncate text-xs font-semibold text-brand-plum dark:text-brand-text">
                    Web browser
                  </p>
                  <p className="text-xs uppercase text-brand-text-muted">
                    {workingId === device.deviceId
                      ? 'Removal in progress'
                      : `${device.platform} · Last seen ${new Date(device.lastSeenAt).toLocaleDateString()}`}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setRevocationTarget(device)}
                disabled={securityUpgradeRequired || Boolean(workingId)}
                className="flex h-9 w-9 items-center justify-center rounded-lg border border-red-200 text-red-600 disabled:opacity-40"
                title={
                  securityUpgradeRequired
                    ? 'Finish security upgrade first'
                    : workingId === device.deviceId
                      ? 'Removing device securely'
                      : 'Remove device'
                }
                aria-busy={workingId === device.deviceId}
              >
                {workingId === device.deviceId ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4" />
                )}
              </button>
            </div>
          ))}
        </div>
      )}

      {!loading && sessions.length === 0 && devices.length === 0 && !error && (
        <p className="border-t border-brand-border pt-3 text-xs text-brand-text-muted">
          No browsers are waiting for approval.
        </p>
      )}
      {message && <p className="text-xs font-semibold text-brand-sage">{message}</p>}
      {error && <p className="text-xs font-semibold text-red-600 dark:text-red-400">{error}</p>}

      <BottomSheet
        open={Boolean(revocationTarget)}
        title="Remove device?"
        description="Secure removal will continue in the background. You can keep using the app while the encrypted account key is rotated."
        onClose={() => !workingId && setRevocationTarget(null)}
      >
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setRevocationTarget(null)}
            disabled={Boolean(workingId)}
            className="flex-1 rounded-xl border border-brand-border px-4 py-3 text-sm font-bold text-brand-plum disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={revoke}
            disabled={Boolean(workingId)}
            className="flex-1 rounded-xl bg-red-600 px-4 py-3 text-sm font-bold text-white disabled:opacity-40"
          >
            Remove Device
          </button>
        </div>
      </BottomSheet>
    </section>
  );
}
