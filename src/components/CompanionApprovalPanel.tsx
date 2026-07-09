import { useEffect, useRef, useState } from 'react';
import { Check, Link2, LoaderCircle, Monitor, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import type { PairingSession, SyncDevice } from '../types';
import { diaryRepository, eventSyncEngine } from '../repositories';
import { approveCompanionPairing } from '../sync/companionPairing';
import { createConfiguredSupabaseControlPlaneClient } from '../sync/config';
import { resumePendingDeviceKeyRotation, revokeDeviceWithKeyRotation } from '../sync/deviceKeyRotation';
import { loadSyncSecrets } from '../sync/syncSecrets';
import { restoreGoogleDriveSession } from '../utils/googleAuth';
import PassphraseConfirmationDialog from './PassphraseConfirmationDialog';

export default function CompanionApprovalPanel() {
  const [sessions, setSessions] = useState<PairingSession[]>([]);
  const [devices, setDevices] = useState<SyncDevice[]>([]);
  const [isPrimary, setIsPrimary] = useState<boolean | null>(null);
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [approvingId, setApprovingId] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [revocationTarget, setRevocationTarget] = useState<SyncDevice | null>(null);
  const [revocationError, setRevocationError] = useState('');
  const revocationInFlightRef = useRef(false);

  const refresh = async (showLoading = true) => {
    if (revocationInFlightRef.current) {
      if (showLoading) setLoading(false);
      return;
    }
    if (showLoading) setLoading(true);
    setError('');
    try {
      const state = await diaryRepository.getLocalSyncAccountState();
      if (!state || state.deviceRole !== 'primary_mobile') {
        setIsPrimary(false);
        setSessions([]);
        return;
      }
      setIsPrimary(true);
      await eventSyncEngine.pullPending();
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

  const closeRevocationDialog = () => {
    if (approvingId) return;
    setRevocationTarget(null);
    setRevocationError('');
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
            <p className="text-[10px] text-brand-sage">Approve a browser displaying a pairing code.</p>
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

      {!loading && sessions.length === 0 && !error && (
        <p className="border-t border-brand-border pt-3 text-[11px] text-brand-text-muted">No browsers are waiting for approval.</p>
      )}
      {sessions.map(session => (
        <div key={session.id} className="flex flex-col gap-3 border-t border-brand-border pt-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-xs font-bold text-brand-plum dark:text-brand-text">{session.requestedDisplayName}</p>
              <p className="text-[10px] uppercase text-brand-text-muted">{session.requestedPlatform}</p>
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
      {devices.length > 0 && (
        <div className="flex flex-col gap-2 border-t border-brand-border pt-3">
          <p className="text-[10px] font-bold uppercase text-brand-sage">Linked companions</p>
          {devices.map(device => (
            <div key={device.id} className="flex items-center justify-between gap-3 py-1">
              <div className="flex min-w-0 items-center gap-2">
                <Monitor className="h-4 w-4 shrink-0 text-brand-sage" />
                <div className="min-w-0">
                  <p className="truncate text-xs font-semibold text-brand-plum dark:text-brand-text">{device.displayName}</p>
                  <p className="text-[9px] uppercase text-brand-text-muted">{device.platform}</p>
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
      {message && <p className="text-[11px] font-semibold text-brand-sage">{message}</p>}
      {error && <p className="text-[11px] font-semibold text-red-600 dark:text-red-400">{error}</p>}
      <PassphraseConfirmationDialog
        open={Boolean(revocationTarget)}
        title="Revoke companion device"
        description={`This will revoke ${revocationTarget?.displayName || 'the selected companion'}, rotate your encrypted account key, and require the recovery passphrase before any key packages are published.`}
        confirmLabel="Revoke device"
        loading={Boolean(revocationTarget && approvingId === revocationTarget.id)}
        error={revocationError}
        onCancel={closeRevocationDialog}
        onConfirm={passphrase => {
          if (revocationTarget) void revoke(revocationTarget, passphrase);
        }}
      />
    </section>
  );
}
