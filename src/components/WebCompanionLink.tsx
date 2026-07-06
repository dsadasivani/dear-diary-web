import { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Check, Clipboard, Cloud, LoaderCircle, ShieldCheck } from 'lucide-react';
import { diaryRepository } from '../repositories';
import {
  completeCompanionPairing,
  createCompanionPairingRequest,
  type PendingCompanionPairing,
} from '../sync/companionPairing';
import { createConfiguredSupabaseControlPlaneClient } from '../sync/config';
import {
  clearPendingPairingSecret,
  loadPendingPairingSecret,
  savePendingPairingSecret,
} from '../sync/syncSecrets';
import {
  restoreWebGoogleSyncSession,
  signOutWebGoogleSync,
  startWebGoogleSyncSignIn,
  type WebGoogleSyncSession,
} from '../sync/webGoogleAuth';

interface PendingWebCompanion {
  pairing: PendingCompanionPairing;
  auth: WebGoogleSyncSession;
}

interface WebCompanionLinkProps {
  onLinked: () => void | Promise<void>;
}

let pairingInitializationPromise: Promise<PendingWebCompanion | null> | null = null;
let pairingCompletionPromise: ReturnType<typeof completeCompanionPairing> | null = null;

const initializePairing = (): Promise<PendingWebCompanion | null> => {
  if (!pairingInitializationPromise) {
    pairingInitializationPromise = (async () => {
      const stored = await loadPendingPairingSecret<PendingWebCompanion>();
      if (stored) return stored;
      const auth = await restoreWebGoogleSyncSession();
      if (!auth) return null;
      const controlPlane = createConfiguredSupabaseControlPlaneClient(auth.supabaseSession.accessToken);
      if (!await controlPlane.lookupCurrentGoogleAccount()) {
        await signOutWebGoogleSync();
        throw new Error('No Dear Diary account exists for this Google account. Create it on mobile first.');
      }
      const pairing = await createCompanionPairingRequest({
        controlPlane,
        displayName: navigator.userAgentData?.platform || navigator.platform || 'Web browser',
        platform: 'web',
      });
      const next = { pairing, auth };
      await savePendingPairingSecret(next);
      return next;
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
        const controlPlane = createConfiguredSupabaseControlPlaneClient(context.auth.supabaseSession.accessToken);
        if (!pairingCompletionPromise) {
          pairingCompletionPromise = completeCompanionPairing({
            pending: context.pairing,
            repository: diaryRepository,
            controlPlane,
            googleSession: context.auth.googleSession,
            supabaseSession: context.auth.supabaseSession,
          }).finally(() => { pairingCompletionPromise = null; });
        }
        const linked = await pairingCompletionPromise;
        if (linked && active) {
          await clearPendingPairingSecret();
          setStatus('Companion approved. Opening your encrypted diary...');
          await onLinked();
        }
      } catch (approvalError: any) {
        if (approvalError?.message?.includes('expired')) {
          await clearPendingPairingSecret();
          pairingInitializationPromise = null;
          if (active) { setContext(null); setStatus('Pairing expired. Sign in to start a new request.'); }
        } else if (active) {
          setError(approvalError?.message || 'Pairing approval could not be completed.');
        }
      } finally {
        completingRef.current = false;
      }
    };
    void checkApproval();
    const timer = setInterval(() => void checkApproval(), 3_000);
    return () => { active = false; clearInterval(timer); };
  }, [context, onLinked]);

  const pairingPayload = useMemo(() => context ? JSON.stringify({
    version: 1,
    sessionId: context.pairing.session.id,
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
          ) : (
            <div className="flex flex-col items-center gap-5 text-center">
              <div>
                <p className="text-[10px] font-bold uppercase text-brand-sage">Pairing Code</p>
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

        <div className="flex items-start gap-2 text-[11px] leading-relaxed text-brand-text-muted">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-brand-sage" />
          <p>Your primary mobile must approve this code before encrypted diary keys are released.</p>
        </div>
      </div>
    </main>
  );
}
