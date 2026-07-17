import { useEffect, useRef, useState } from 'react';
import { Check, Link2, LoaderCircle, Monitor, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import type { LocalSyncAccountState, PairingSession, SyncDevice } from '../types';
import { diaryRepository, eventSyncEngine } from '../repositories';
import { approveCompanionPairing } from '../sync/companionPairing';
import { createConfiguredSupabaseControlPlaneClient } from '../sync/config';
import { resumePendingDeviceKeyRotation, revokeDeviceWithKeyRotation } from '../sync/deviceKeyRotation';
import { loadSyncSecrets } from '../sync/syncSecrets';
import { restoreGoogleDriveSession } from '../utils/googleAuth';
import type { SyncV2Device, SyncV2Pairing } from '../sync/v2/api/SyncV2ApiTypes';
import { approveSyncV2CompanionPairing, listPendingSyncV2Pairings } from '../sync/v2/v2CompanionPairing';
import {
  listSyncV2Devices,
  resumePendingSyncV2DeviceRevocation,
  revokeSyncV2Device,
} from '../sync/v2/v2DeviceManagement';
import PassphraseConfirmationDialog from './PassphraseConfirmationDialog';

export const pairingCompatibilityError = (
  state: Pick<LocalSyncAccountState, 'accountId' | 'v1AccountId' | 'syncProtocolVersion'> | null,
  session: Pick<PairingSession, 'accountId'>,
): string | null => {
  if (!state || session.accountId === state.accountId) return null;
  if (state.syncProtocolVersion === 2 && session.accountId === state.v1AccountId) {
    return 'This browser used an outdated pairing request. No encryption keys were released. Refresh the browser and try again.';
  }
  return 'Pairing request belongs to another encrypted account.';
};

export default function CompanionApprovalPanel() {
  const [sessions, setSessions] = useState<PairingSession[]>([]);
  const [v2Sessions, setV2Sessions] = useState<SyncV2Pairing[]>([]);
  const [devices, setDevices] = useState<SyncDevice[]>([]);
  const [v2Devices, setV2Devices] = useState<SyncV2Device[]>([]);
  const [isPrimary, setIsPrimary] = useState<boolean | null>(null);
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [approvingId, setApprovingId] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [revocationTarget, setRevocationTarget] = useState<SyncDevice | null>(null);
  const [v2RevocationTarget, setV2RevocationTarget] = useState<SyncV2Device | null>(null);
  const [revocationError, setRevocationError] = useState('');
  const revocationInFlightRef = useRef(false);

  const refresh = async (showLoading = true) => {
    if (revocationInFlightRef.current) {
      if (showLoading) setLoading(false);
      return;
    }
    if (showLoading) setLoading(true);
    if (showLoading) setError('');
    try {
      const state = await diaryRepository.getLocalSyncAccountState();
      if (!state || state.deviceRole !== 'primary_mobile') {
        setIsPrimary(false);
        setSessions([]);
        return;
      }
      setIsPrimary(true);
      if (state.syncProtocolVersion === 2) {
        setSessions([]);
        setDevices([]);
        const resumed = await resumePendingSyncV2DeviceRevocation();
        if (resumed === 'completed') setMessage('Pending companion revocation completed safely.');
        if (resumed === 'needs-passphrase') {
          setError('A companion revocation needs the recovery passphrase to continue. Select that companion again.');
        }
        const [pendingPairings, accountDevices] = await Promise.all([
          listPendingSyncV2Pairings(state.deviceId),
          listSyncV2Devices(state.deviceId),
        ]);
        setV2Sessions(pendingPairings);
        setV2Devices(accountDevices.filter(device =>
          device.deviceRole === 'COMPANION' && device.deviceStatus === 'ACTIVE',
        ));
        return;
      }
      setV2Sessions([]);
      setV2Devices([]);
      // Pairing discovery is a read-only control-plane operation. A paused or
      // temporarily unavailable data pull must not hide pending companions or
      // prevent the primary device from managing already-linked devices.
      const secrets = await loadSyncSecrets();
      if (!secrets) throw new Error('Encrypted sync credentials are unavailable.');
      const controlPlane = createConfiguredSupabaseControlPlaneClient(secrets.supabaseSession.accessToken);
      const googleSession = await restoreGoogleDriveSession(false).catch(() => null) || secrets.googleSession || null;
      const resumeResult = await resumePendingDeviceKeyRotation({
        repository: diaryRepository,
        controlPlane,
        googleSession,
      });
      if (resumeResult.status === 'completed' || resumeResult.status === 'aborted') {
        setMessage(resumeResult.message);
      }
      const [pendingSessions, accountDevices] = await Promise.all([
        controlPlane.listPendingPairingSessions(state.deviceId),
        controlPlane.listAccountDevices(state.deviceId),
      ]);
      setSessions(pendingSessions);
      setDevices(accountDevices.filter(device => device.role !== 'primary_mobile' && !device.revokedAt));
    } catch (refreshError: any) {
      setError(refreshError?.message || 'Could not load companion requests.');
    } finally {
      if (showLoading) setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      void refresh(false);
    }, 5_000);
    return () => window.clearInterval(timer);
  }, []);

  if (isPrimary !== true) return null;

  const approve = async (session: PairingSession) => {
    const pairingCode = (codes[session.id] || '').trim();
    if (pairingCode.length !== 8) {
      setError('Enter the 8-digit code shown in the companion browser.');
      return;
    }
    setApprovingId(session.id);
    setError('');
    setMessage('');
    try {
      const state = await diaryRepository.getLocalSyncAccountState();
      const compatibilityError = pairingCompatibilityError(state, session);
      if (compatibilityError) throw new Error(compatibilityError);
      const secrets = await loadSyncSecrets();
      if (!secrets) throw new Error('Encrypted sync credentials are unavailable.');
      const googleSession = await restoreGoogleDriveSession(false) || await restoreGoogleDriveSession(true);
      if (!googleSession) throw new Error('Google Drive authorization is required to approve this companion.');
      const controlPlane = createConfiguredSupabaseControlPlaneClient(secrets.supabaseSession.accessToken);
      setMessage('Preparing an encrypted restore point for this companion...');
      await eventSyncEngine.createSnapshot();
      await approveCompanionPairing({
        sessionId: session.id,
        pairingCode,
        repository: diaryRepository,
        controlPlane,
        googleSession,
      });
      setMessage(`${session.requestedDisplayName} is now linked.`);
      setCodes(current => ({ ...current, [session.id]: '' }));
      await refresh();
    } catch (approvalError: any) {
      setMessage('');
      setError(approvalError?.message || 'Companion approval failed.');
    } finally {
      setApprovingId('');
    }
  };

  const approveV2 = async (session: SyncV2Pairing) => {
    const pairingCode = (codes[session.pairingId] || '').trim();
    if (pairingCode.length !== 8) {
      setError('Enter the 8-digit code shown in the companion browser.');
      return;
    }
    setApprovingId(session.pairingId);
    setError('');
    setMessage('');
    try {
      setMessage('Encrypting this diary key for the companion...');
      await approveSyncV2CompanionPairing(session, pairingCode);
      setMessage('Web browser approved. It is restoring the encrypted diary.');
      setCodes(current => ({ ...current, [session.pairingId]: '' }));
      await refresh();
    } catch (approvalError: any) {
      setMessage('');
      setError(approvalError?.message || 'Companion approval failed.');
    } finally {
      setApprovingId('');
    }
  };

  const openRevocationDialog = (device: SyncDevice) => {
    setRevocationTarget(device);
    setRevocationError('');
    setError('');
    setMessage('');
  };

  const openV2RevocationDialog = (device: SyncV2Device) => {
    setV2RevocationTarget(device);
    setRevocationError('');
    setError('');
    setMessage('');
  };

  const closeRevocationDialog = () => {
    if (approvingId) return;
    setRevocationTarget(null);
    setV2RevocationTarget(null);
    setRevocationError('');
  };

  const revokeV2 = async (device: SyncV2Device, recoveryPassphrase: string) => {
    revocationInFlightRef.current = true;
    setApprovingId(device.deviceId);
    setError('');
    setMessage('');
    setRevocationError('');
    try {
      await eventSyncEngine.pullPending();
      await revokeSyncV2Device({ targetDeviceId: device.deviceId, recoveryPassphrase });
      setMessage('Companion revoked and the encrypted account key was rotated.');
      setV2RevocationTarget(null);
      revocationInFlightRef.current = false;
      await refresh();
    } catch (revokeError: any) {
      const failure = revokeError?.message || 'Device revocation failed.';
      setRevocationError(failure);
      setError(failure);
      revocationInFlightRef.current = false;
    } finally {
      setApprovingId('');
    }
  };

  const revoke = async (device: SyncDevice, recoveryPassphrase: string) => {
    revocationInFlightRef.current = true;
    setApprovingId(device.id);
    setError('');
    setMessage('');
    setRevocationError('');
    try {
      await eventSyncEngine.pullPending();
      const secrets = await loadSyncSecrets();
      if (!secrets) throw new Error('Primary device credentials are unavailable.');
      const controlPlane = createConfiguredSupabaseControlPlaneClient(secrets.supabaseSession.accessToken);
      const googleSession = await restoreGoogleDriveSession(false) || await restoreGoogleDriveSession(true);
      if (!googleSession) throw new Error('Google Drive authorization is required to distribute the new key epoch.');
      const result = await revokeDeviceWithKeyRotation({
        repository: diaryRepository,
        controlPlane,
        googleSession,
        targetDevice: device,
        recoveryPassphrase,
      });
      if (result.status === 'completed' || result.status === 'aborted') setMessage(result.message);
      setRevocationTarget(null);
      setRevocationError('');
      revocationInFlightRef.current = false;
      await refresh();
    } catch (revokeError: any) {
      const message = revokeError?.message || 'Device revocation failed.';
      setRevocationError(message);
      setError(message);
      revocationInFlightRef.current = false;
    } finally {
      setApprovingId('');
    }
  };

  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-brand-border bg-brand-card-bg p-5 journal-shadow">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="rounded-lg bg-brand-sage/10 p-2.5 text-brand-sage"><Link2 className="h-4 w-4" /></span>
          <div>
            <h3 className="text-sm font-bold text-brand-plum dark:text-brand-text">Companion Devices</h3>
            <p className="text-xs text-brand-sage">Approve a browser displaying a pairing code.</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-brand-border text-brand-sage disabled:opacity-50"
          title="Refresh pairing requests"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {!loading && sessions.length === 0 && v2Sessions.length === 0 && devices.length === 0 && v2Devices.length === 0 && !error && (
        <p className="border-t border-brand-border pt-3 text-xs text-brand-text-muted">No browsers are waiting for approval.</p>
      )}
      {sessions.map(session => (
        <div key={session.id} className="flex flex-col gap-3 border-t border-brand-border pt-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-xs font-bold text-brand-plum dark:text-brand-text">{session.requestedDisplayName}</p>
              <p className="text-xs uppercase text-brand-text-muted">{session.requestedPlatform}</p>
            </div>
            <ShieldCheck className="h-4 w-4 shrink-0 text-brand-sage" />
          </div>
          <div className="flex gap-2">
            <input
              inputMode="numeric"
              maxLength={8}
              value={codes[session.id] || ''}
              onChange={event => setCodes(current => ({
                ...current,
                [session.id]: event.target.value.replace(/\D/g, '').slice(0, 8),
              }))}
              className="min-w-0 flex-1 rounded-lg border border-brand-border bg-brand-bg px-3 py-2 font-mono text-sm tracking-widest text-brand-plum outline-none focus:border-brand-pink"
              placeholder="8-digit code"
              aria-label={`Pairing code for ${session.requestedDisplayName}`}
            />
            <button
              type="button"
              onClick={() => void approve(session)}
              disabled={approvingId === session.id || (codes[session.id] || '').length !== 8}
              className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-sage text-white disabled:opacity-40"
              title="Approve companion"
            >
              {approvingId === session.id ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            </button>
          </div>
        </div>
      ))}
      {v2Sessions.map(session => (
        <div key={session.pairingId} className="flex flex-col gap-3 border-t border-brand-border pt-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-xs font-bold text-brand-plum dark:text-brand-text">Web browser</p>
              <p className="text-xs uppercase text-brand-text-muted">{session.platform}</p>
            </div>
            <ShieldCheck className="h-4 w-4 shrink-0 text-brand-sage" />
          </div>
          <div className="flex gap-2">
            <input
              inputMode="numeric"
              maxLength={8}
              value={codes[session.pairingId] || ''}
              onChange={event => setCodes(current => ({
                ...current,
                [session.pairingId]: event.target.value.replace(/\D/g, '').slice(0, 8),
              }))}
              className="min-w-0 flex-1 rounded-lg border border-brand-border bg-brand-bg px-3 py-2 font-mono text-sm tracking-widest text-brand-plum outline-none focus:border-brand-pink"
              placeholder="8-digit code"
              aria-label="Pairing code for Web browser"
            />
            <button
              type="button"
              onClick={() => void approveV2(session)}
              disabled={approvingId === session.pairingId || (codes[session.pairingId] || '').length !== 8}
              className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-sage text-white disabled:opacity-40"
              title="Approve companion"
            >
              {approvingId === session.pairingId ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            </button>
          </div>
        </div>
      ))}
      {devices.length > 0 && (
        <div className="flex flex-col gap-2 border-t border-brand-border pt-3">
          <p className="text-xs font-bold uppercase text-brand-sage">Linked companions</p>
          {devices.map(device => (
            <div key={device.id} className="flex items-center justify-between gap-3 py-1">
              <div className="flex min-w-0 items-center gap-2">
                <Monitor className="h-4 w-4 shrink-0 text-brand-sage" />
                <div className="min-w-0">
                  <p className="truncate text-xs font-semibold text-brand-plum dark:text-brand-text">{device.displayName}</p>
                  <p className="text-xs uppercase text-brand-text-muted">{device.platform}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => openRevocationDialog(device)}
                disabled={approvingId === device.id}
                className="flex h-9 w-9 items-center justify-center rounded-lg border border-red-200 text-red-600 disabled:opacity-40"
                title="Revoke companion"
              >
                {approvingId === device.id ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              </button>
            </div>
          ))}
        </div>
      )}
      {v2Devices.length > 0 && (
        <div className="flex flex-col gap-2 border-t border-brand-border pt-3">
          <p className="text-xs font-bold uppercase text-brand-sage">Linked companions</p>
          {v2Devices.map(device => (
            <div key={device.deviceId} className="flex items-center justify-between gap-3 py-1">
              <div className="flex min-w-0 items-center gap-2">
                <Monitor className="h-4 w-4 shrink-0 text-brand-sage" />
                <div className="min-w-0">
                  <p className="truncate text-xs font-semibold text-brand-plum dark:text-brand-text">Web browser</p>
                  <p className="text-xs uppercase text-brand-text-muted">
                    {device.platform} · Last seen {new Date(device.lastSeenAt).toLocaleDateString()}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => openV2RevocationDialog(device)}
                disabled={approvingId === device.deviceId}
                className="flex h-9 w-9 items-center justify-center rounded-lg border border-red-200 text-red-600 disabled:opacity-40"
                title="Revoke companion"
              >
                {approvingId === device.deviceId ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              </button>
            </div>
          ))}
        </div>
      )}
      {message && <p className="text-xs font-semibold text-brand-sage">{message}</p>}
      {error && <p className="text-xs font-semibold text-red-600 dark:text-red-400">{error}</p>}
      <PassphraseConfirmationDialog
        open={Boolean(revocationTarget || v2RevocationTarget)}
        title="Revoke companion device"
        description={`This will revoke ${revocationTarget?.displayName || (v2RevocationTarget ? 'the selected web browser' : 'the selected companion')}, rotate your encrypted account key, and require the recovery passphrase before any key packages are published.`}
        confirmLabel="Revoke device"
        loading={Boolean(
          (revocationTarget && approvingId === revocationTarget.id)
          || (v2RevocationTarget && approvingId === v2RevocationTarget.deviceId)
        )}
        error={revocationError}
        onCancel={closeRevocationDialog}
        onConfirm={passphrase => {
          if (revocationTarget) void revoke(revocationTarget, passphrase);
          else if (v2RevocationTarget) void revokeV2(v2RevocationTarget, passphrase);
        }}
      />
    </section>
  );
}
