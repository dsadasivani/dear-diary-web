import { useEffect, useState } from 'react';
import { Check, Link2, LoaderCircle, Monitor, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import type { PairingSession, RecoveryKeyPackage, SyncDevice, SyncObjectMetadata } from '../types';
import { diaryRepository, eventSyncEngine } from '../repositories';
import type { GoogleAccountSession } from '../types';
import { encodeCompanionKeyPackage, wrapRootKeyForCompanion } from '../sync/companionKeyPackage';
import { approveCompanionPairing } from '../sync/companionPairing';
import { createConfiguredSupabaseControlPlaneClient } from '../sync/config';
import { uploadDriveSyncObject } from '../sync/driveSyncObjects';
import {
  decodeRecoveryKeyPackage,
  encodeRecoveryKeyPackage,
  generateAccountRootKey,
  unwrapAccountRootKeyFromRecovery,
  wrapAccountRootKeyForRecovery,
} from '../sync/e2eeKeyPackage';
import { downloadVerifiedSyncObject } from '../sync/eventReplay';
import { loadSyncSecrets, saveSyncSecrets, withAccountRootKeyForEpoch } from '../sync/syncSecrets';
import type { SyncSecrets } from '../sync/syncSecrets';
import { restoreGoogleDriveSession } from '../utils/googleAuth';

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
};

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
};

const promptForRecoveryPassphrase = (deviceName: string): string => {
  if (typeof window === 'undefined' || typeof window.prompt !== 'function') {
    throw new Error('Recovery passphrase confirmation is required before rotating account keys.');
  }
  const passphrase = window.prompt(
    `Confirm your recovery passphrase to revoke ${deviceName} and rotate your encrypted account key.`,
  );
  if (!passphrase) throw new Error('Device revocation was canceled.');
  return passphrase;
};

const latestRecoveryPackageForAccount = async ({
  accountId,
  objects,
  googleSession,
}: {
  accountId: string;
  objects: SyncObjectMetadata[];
  googleSession: GoogleAccountSession;
}): Promise<{ object: SyncObjectMetadata; keyPackage: RecoveryKeyPackage }> => {
  const candidates = objects
    .filter(object => object.objectKind === 'key_package')
    .sort((left, right) => right.sequence - left.sequence);

  for (const object of candidates) {
    try {
      const bytes = await downloadVerifiedSyncObject(googleSession, object);
      const keyPackage = decodeRecoveryKeyPackage(bytes);
      if (keyPackage.accountId && keyPackage.accountId !== accountId) continue;
      return { object, keyPackage };
    } catch {
      // Companion packages and damaged recovery packages are not recovery passphrase proof.
    }
  }
  throw new Error('No usable recovery key package was found for this account.');
};

const verifyRecoveryPassphraseForRotation = async ({
  accountId,
  passphrase,
  secrets,
  objects,
  googleSession,
}: {
  accountId: string;
  passphrase: string;
  secrets: SyncSecrets;
  objects: SyncObjectMetadata[];
  googleSession: GoogleAccountSession;
}): Promise<{ keyPackage: RecoveryKeyPackage }> => {
  const latest = await latestRecoveryPackageForAccount({ accountId, objects, googleSession });
  const recoveredRootKey = await unwrapAccountRootKeyFromRecovery(latest.keyPackage, passphrase);
  const knownRootKeys = [secrets.accountRootKey, ...Object.values(secrets.accountRootKeys || {})];
  if (!knownRootKeys.some(key => equalBytes(key, recoveredRootKey))) {
    throw new Error('The recovery package does not match this device account.');
  }
  return { keyPackage: latest.keyPackage };
};

export default function CompanionApprovalPanel() {
  const [sessions, setSessions] = useState<PairingSession[]>([]);
  const [devices, setDevices] = useState<SyncDevice[]>([]);
  const [isPrimary, setIsPrimary] = useState<boolean | null>(null);
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [approvingId, setApprovingId] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const refresh = async (showLoading = true) => {
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

  const revoke = async (device: SyncDevice) => {
    setApprovingId(device.id);
    setError('');
    setMessage('');
    try {
      await eventSyncEngine.pullPending();
      const state = await diaryRepository.getLocalSyncAccountState();
      const secrets = await loadSyncSecrets();
      if (!state || !secrets) throw new Error('Primary device credentials are unavailable.');
      const controlPlane = createConfiguredSupabaseControlPlaneClient(secrets.supabaseSession.accessToken);
      const googleSession = await restoreGoogleDriveSession(false) || await restoreGoogleDriveSession(true);
      if (!googleSession) throw new Error('Google Drive authorization is required to distribute the new key epoch.');
      const recoveryPassphrase = promptForRecoveryPassphrase(device.displayName);
      const recoveryObjects = await controlPlane.listAccountRecoveryObjects();
      const recoveryProof = await verifyRecoveryPassphraseForRotation({
        accountId: state.accountId,
        passphrase: recoveryPassphrase,
        secrets,
        objects: recoveryObjects,
        googleSession,
      });
      const rotation = await controlPlane.beginDeviceKeyRotation({
        primaryDeviceId: state.deviceId,
        deviceId: device.id,
        reason: 'revoked_by_primary',
      });
      const nextKeyEpoch = rotation.nextKeyEpoch;
      const nextRootKey = generateAccountRootKey();
      const updatedSecrets = withAccountRootKeyForEpoch({
        ...secrets,
        accountRootKeys: {
          ...(secrets.accountRootKeys || {}),
          [state.keyEpoch || 1]: secrets.accountRootKey,
        },
      }, nextKeyEpoch, nextRootKey);
      let lastKeyPackageSequence = rotation.startingSequence;
      try {
        lastKeyPackageSequence = await publishRecoveryKeyEpochPackage({
          accountId: state.accountId,
          primaryDeviceId: state.deviceId,
          rotationId: rotation.id,
          keyEpoch: nextKeyEpoch,
          keyVersion: Math.max(recoveryProof.keyPackage.keyVersion + 1, nextKeyEpoch),
          accountRootKey: nextRootKey,
          recoveryPassphrase,
          googleSession,
          controlPlane,
          afterSequence: lastKeyPackageSequence,
        });
        const remainingDevices = (await controlPlane.listAccountDevices(state.deviceId))
          .filter(candidate => (
            candidate.role !== 'primary_mobile' &&
            candidate.id !== device.id &&
            !candidate.revokedAt
          ));
        const account = await controlPlane.lookupCurrentGoogleAccount();
        lastKeyPackageSequence = await publishKeyEpochPackages({
          accountId: state.accountId,
          primaryDeviceId: state.deviceId,
          rotationId: rotation.id,
          keyEpoch: nextKeyEpoch,
          accountRootKey: nextRootKey,
          accountRootKeys: updatedSecrets.accountRootKeys || { [nextKeyEpoch]: nextRootKey },
          googleSession,
          devices: remainingDevices,
          controlPlane,
          afterSequence: Math.max(lastKeyPackageSequence, account?.currentSyncSequence ?? rotation.startingSequence),
        });
        await saveSyncSecrets({
          ...secrets,
          accountRootKeys: {
            ...(secrets.accountRootKeys || {}),
            [state.keyEpoch || 1]: secrets.accountRootKey,
            [nextKeyEpoch]: nextRootKey,
          },
        });
        await controlPlane.finalizeDeviceKeyRotation({
          primaryDeviceId: state.deviceId,
          rotationId: rotation.id,
          keyPackageSequence: lastKeyPackageSequence,
        });
      } catch (rotationError) {
        await controlPlane.abortDeviceKeyRotation(state.deviceId, rotation.id).catch(error => {
          console.warn('Pending key rotation could not be aborted:', error);
        });
        throw rotationError;
      }
      await saveSyncSecrets(updatedSecrets);
      const updatedState = {
        ...state,
        keyEpoch: nextKeyEpoch,
        currentSyncSequence: Math.max(state.currentSyncSequence, lastKeyPackageSequence),
      };
      await diaryRepository.saveLocalSyncAccountState(updatedState);
      if (updatedState.currentSyncSequence > state.currentSyncSequence) {
        await controlPlane.updateDeviceCursor({
          deviceId: state.deviceId,
          lastAppliedSequence: updatedState.currentSyncSequence,
        });
      }
      setMessage(`${device.displayName} was revoked. Future sync writes will use key epoch ${nextKeyEpoch}.`);
      await refresh();
    } catch (revokeError: any) {
      setError(revokeError?.message || 'Device revocation failed.');
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
                onClick={() => void revoke(device)}
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
    </section>
  );
}

const publishKeyEpochPackages = async ({
  accountId,
  primaryDeviceId,
  rotationId,
  keyEpoch,
  accountRootKey,
  accountRootKeys,
  googleSession,
  devices,
  controlPlane,
  afterSequence,
}: {
  accountId: string;
  primaryDeviceId: string;
  rotationId: string;
  keyEpoch: number;
  accountRootKey: Uint8Array;
  accountRootKeys: Record<number, Uint8Array>;
  googleSession: GoogleAccountSession;
  devices: SyncDevice[];
  controlPlane: ReturnType<typeof createConfiguredSupabaseControlPlaneClient>;
  afterSequence: number;
}): Promise<number> => {
  let latestSequence = afterSequence;
  for (const device of devices) {
    const keyPackage = await wrapRootKeyForCompanion(accountRootKey, accountId, device.publicKey, {
      keyEpoch,
      accountRootKeys,
    });
    const bytes = encodeCompanionKeyPackage(keyPackage);
    const file = await uploadDriveSyncObject({
      session: googleSession,
      name: `/key-packages/root-key-epoch-${keyEpoch}-${rotationId}-${device.id}.ddkey`,
      objectKind: 'key_package',
      bytes,
      appProperties: {
        accountId,
        keyEpoch,
        rotationId,
        targetDeviceId: device.id,
        targetDevicePublicKeySha256: keyPackage.targetDevicePublicKeySha256,
      },
    });
    const committed = await controlPlane.commitSyncObject({
      deviceId: primaryDeviceId,
      afterSequence: latestSequence,
      driveFileId: file.id,
      objectKind: 'key_package',
      sha256: await sha256Hex(bytes),
      sizeBytes: bytes.byteLength,
      operationId: `key-epoch:${accountId}:${keyEpoch}:${rotationId}:${device.id}`,
      keyEpoch,
    });
    latestSequence = Math.max(latestSequence, committed.sequence);
  }
  return latestSequence;
};

const publishRecoveryKeyEpochPackage = async ({
  accountId,
  primaryDeviceId,
  rotationId,
  keyEpoch,
  keyVersion,
  accountRootKey,
  recoveryPassphrase,
  googleSession,
  controlPlane,
  afterSequence,
}: {
  accountId: string;
  primaryDeviceId: string;
  rotationId: string;
  keyEpoch: number;
  keyVersion: number;
  accountRootKey: Uint8Array;
  recoveryPassphrase: string;
  googleSession: GoogleAccountSession;
  controlPlane: ReturnType<typeof createConfiguredSupabaseControlPlaneClient>;
  afterSequence: number;
}): Promise<number> => {
  const keyPackage = await wrapAccountRootKeyForRecovery(accountRootKey, recoveryPassphrase, {
    accountId,
    keyVersion,
  });
  const bytes = encodeRecoveryKeyPackage(keyPackage);
  const file = await uploadDriveSyncObject({
    session: googleSession,
    name: `/key-packages/root-key-epoch-${keyEpoch}-${rotationId}-recovery.ddkey`,
    objectKind: 'key_package',
    bytes,
    appProperties: {
      accountId,
      keyEpoch,
      keyVersion,
      rotationId,
      purpose: 'recovery',
    },
  });
  const committed = await controlPlane.commitSyncObject({
    deviceId: primaryDeviceId,
    afterSequence,
    driveFileId: file.id,
    objectKind: 'key_package',
    sha256: await sha256Hex(bytes),
    sizeBytes: bytes.byteLength,
    operationId: `key-epoch-recovery:${accountId}:${keyEpoch}:${rotationId}`,
    keyEpoch,
  });
  return Math.max(afterSequence, committed.sequence);
};
