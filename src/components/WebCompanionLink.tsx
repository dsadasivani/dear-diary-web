import { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Check, Clipboard, Cloud, LoaderCircle, ShieldCheck } from 'lucide-react';
import { diaryRepository } from '../repositories';
import type { LocalSyncAccountState } from '../types';
import {
  completeSyncV2CompanionPairing,
  getPendingSyncV2CompanionPairing,
  requestSyncV2CompanionPairing,
} from '../sync/v2/v2CompanionPairing';
import {
  restoreWebGoogleSyncSession,
  startWebGoogleSyncSignIn,
  type WebGoogleSyncSession,
} from '../sync/webGoogleAuth';

interface PendingWebCompanion {
  pairing: Awaited<ReturnType<typeof requestSyncV2CompanionPairing>>;
  auth: WebGoogleSyncSession;
}

interface WebCompanionLinkProps {
  onLinked: (syncAccount?: LocalSyncAccountState) => void | Promise<void>;
}

let pairingInitializationPromise: Promise<PendingWebCompanion | null> | null = null;
let pairingCompletionPromise: ReturnType<typeof completeSyncV2CompanionPairing> | null = null;
const APPROVAL_POLL_INTERVAL_MS = 1_000;

const initializePairing = (): Promise<PendingWebCompanion | null> => {
  if (!pairingInitializationPromise) {
    pairingInitializationPromise = (async () => {
      const auth = await restoreWebGoogleSyncSession();
      if (!auth) return null;
      const stored = await getPendingSyncV2CompanionPairing(auth).catch(() => null);
      if (stored && new Date(stored.pairing.expiresAt).getTime() > Date.now()) {
        return {
          pairing: {
            pairingId: stored.pairing.pairingId,
            requestedDeviceId: stored.requestedDeviceId,
            pairingCode: stored.pairingCode,
            expiresAt: stored.pairing.expiresAt,
          },
          auth,
        };
      }
      return { pairing: await requestSyncV2CompanionPairing(auth), auth };
    })().catch(error => {
      pairingInitializationPromise = null;
      throw error;
    });
  }
  return pairingInitializationPromise;
};

export default function WebCompanionLink({ onLinked }: WebCompanionLinkProps) {
  const [context, setContext] = useState<PendingWebCompanion | null>(null);
  const [status, setStatus] = useState('Checking Google sign-in...');
  const [error, setError] = useState('');
  const [isStarting, setIsStarting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const completingRef = useRef(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const initialized = await initializePairing();
        if (!initialized) {
          if (active) setStatus('Sign in with the Google account already linked on your primary mobile.');
          return;
        }
        if (active) { setContext(initialized); setStatus('Waiting for approval from your primary mobile.'); }
      } catch (linkError: any) {
        if (active) { setError(linkError?.message || 'Could not start companion pairing.'); setStatus(''); }
      }
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!context) return;
    let active = true;
    const checkApproval = async () => {
      if (completingRef.current) return;
      completingRef.current = true;
      try {
        const existingLinkedState = await diaryRepository.getLocalSyncAccountState();
        if (existingLinkedState?.syncProtocolVersion === 2) {
          pairingInitializationPromise = null;
          setIsRestoring(true);
          setStatus('Companion approved. Opening your encrypted diary...');
          await onLinked(existingLinkedState);
          return;
        }
        const details = await getPendingSyncV2CompanionPairing(context.auth);
        if (!details || details.pairing.status === 'EXPIRED' || details.pairing.status === 'REJECTED') {
          throw new Error('Pairing request expired.');
        }
        if (details.pairing.status === 'REQUESTED') {
          return;
        }
        if (active) {
          setIsRestoring(true);
          setStatus('Companion approved. Restoring your encrypted diary...');
        }
        if (!pairingCompletionPromise) {
          pairingCompletionPromise = completeSyncV2CompanionPairing(context.auth)
            .finally(() => { pairingCompletionPromise = null; });
        }
        const linked = await pairingCompletionPromise;
        if (linked && active) {
          pairingInitializationPromise = null;
          setIsRestoring(true);
          setStatus('Companion approved. Opening your encrypted diary...');
          await onLinked(linked);
        }
      } catch (approvalError: any) {
        if (approvalError?.message?.includes('expired')) {
          pairingInitializationPromise = null;
          if (active) { setContext(null); setIsRestoring(false); setStatus('Pairing expired. Sign in to start a new request.'); }
        } else if (active) {
          const linkedState = await diaryRepository.getLocalSyncAccountState().catch(() => null);
          if (linkedState) {
            pairingInitializationPromise = null;
            setIsRestoring(true);
            setStatus('Companion approved. Opening your encrypted diary...');
            await onLinked(linkedState);
            return;
          }
          setIsRestoring(false);
          setError(approvalError?.message || 'Pairing approval could not be completed.');
        }
      } finally {
        completingRef.current = false;
      }
    };
    void checkApproval();
    const timer = setInterval(() => void checkApproval(), APPROVAL_POLL_INTERVAL_MS);
    return () => { active = false; clearInterval(timer); };
  }, [context, onLinked]);

  const pairingPayload = useMemo(() => context ? JSON.stringify({
    version: 2,
    protocolVersion: 2,
    sessionId: context.pairing.pairingId,
    pairingCode: context.pairing.pairingCode,
  }) : '', [context]);

  const beginSignIn = async () => {
    setIsStarting(true);
    setError('');
    try { await startWebGoogleSyncSignIn(); }
    catch (signInError: any) {
      setError(signInError?.message || 'Google sign-in could not start.');
      setIsStarting(false);
    }
  };

  const copyPairing = async () => {
    await navigator.clipboard.writeText(pairingPayload);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <main className="min-h-screen min-h-[100dvh] bg-brand-bg px-5 py-8 text-brand-text">
      <div className="mx-auto flex min-h-[calc(100dvh-4rem)] w-full max-w-sm flex-col justify-center gap-6">
        <header className="flex flex-col items-center gap-3 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-lg bg-brand-pink/10 text-brand-pink">
            <BookOpen className="h-6 w-6" />
          </div>
          <div>
            <h1 className="font-serif-diary text-3xl font-bold text-brand-plum">Dear Diary</h1>
            <p className="mt-1 text-xs text-brand-text-muted">Link this browser as a trusted companion.</p>
          </div>
        </header>

        <section className="border-y border-brand-border py-6">
          {!context ? (
            <button
              type="button"
              onClick={beginSignIn}
              disabled={isStarting}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand-sage px-4 py-3 text-xs font-bold text-white disabled:opacity-50"
            >
              {isStarting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Cloud className="h-4 w-4" />}
              <span>{isStarting ? 'Opening Google...' : 'Continue with Google'}</span>
            </button>
          ) : isRestoring ? (
            <div className="flex flex-col items-center gap-4 text-center">
              <LoaderCircle className="h-8 w-8 animate-spin text-brand-pink" />
              <p className="max-w-xs text-xs font-semibold text-brand-text-muted">{status}</p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-5 text-center">
              <div>
                <p className="text-xs font-bold uppercase text-brand-sage">Pairing Code</p>
                <p className="mt-2 font-mono text-4xl font-bold text-brand-plum">{context.pairing.pairingCode}</p>
              </div>
              <button
                type="button"
                onClick={copyPairing}
                className="flex h-10 w-10 items-center justify-center rounded-lg border border-brand-border text-brand-sage hover:text-brand-pink"
                title="Copy pairing request"
              >
                {copied ? <Check className="h-4 w-4" /> : <Clipboard className="h-4 w-4" />}
              </button>
              <div className="flex items-center gap-2 text-xs font-semibold text-brand-text-muted">
                <LoaderCircle className="h-4 w-4 animate-spin text-brand-pink" />
                <span>{status}</span>
              </div>
            </div>
          )}
          {!context && status && <p className="mt-3 text-center text-xs text-brand-text-muted">{status}</p>}
          {error && <p className="mt-3 text-center text-xs font-semibold text-red-600">{error}</p>}
        </section>

        <div className="flex items-start gap-2 text-xs leading-relaxed text-brand-text-muted">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-brand-sage" />
          <p>Your primary mobile must approve this code before encrypted diary keys are released.</p>
        </div>
      </div>
    </main>
  );
}
