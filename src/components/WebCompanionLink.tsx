import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Book as BookOpen,
  Check,
  Computer,
  Copy as Clipboard,
  Download,
  GoogleCircle,
  Lock,
  RefreshDouble as LoaderCircle,
  ShieldCheck,
  SmartphoneDevice,
} from 'iconoir-react';
import { QRCodeSVG } from 'qrcode.react';
import mobileAppPreview from '../../tests/e2e/visual.spec.ts-snapshots/home-light-chromium-mobile-win32.png';
import { diaryRepository } from '../repositories';
import type { LocalSyncAccountState } from '../types';
import {
  completeSyncV2CompanionPairing,
  getPendingSyncV2CompanionPairing,
  requestSyncV2CompanionPairing,
} from '../sync/v2/v2CompanionPairing';
import type { SyncV2Pairing } from '../sync/v2/api/SyncV2ApiTypes';
import {
  restoreWebGoogleSyncSession,
  startWebGoogleSyncSignIn,
  type WebGoogleSyncSession,
} from '../sync/webGoogleAuth';
import { BRAND } from '../config/brand';

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

export const ANDROID_APP_URL =
  import.meta.env.VITE_ANDROID_APP_URL?.trim() ||
  'https://play.google.com/store/apps/details?id=com.deardiary.app';

export const canCompleteWebCompanionPairing = (status: SyncV2Pairing['status']): boolean =>
  status === 'KEY_PACKAGE_AVAILABLE' || status === 'COMPLETED';

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
    })().catch((error) => {
      pairingInitializationPromise = null;
      throw error;
    });
  }
  return pairingInitializationPromise;
};

const setupSteps = [
  {
    title: 'Install on Android',
    description: 'Get the official app from Google Play to keep your memories private and secure.',
    icon: Download,
  },
  {
    title: `Set up ${BRAND.name}`,
    description: 'Create or restore your encrypted account on your primary phone.',
    icon: Lock,
  },
  {
    title: 'Link this browser',
    description: 'Sign in here, then approve this companion from your phone.',
    icon: Computer,
  },
];

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
          if (active)
            setStatus('Sign in with the Google account already linked on your primary mobile.');
          return;
        }
        if (active) {
          setContext(initialized);
          setStatus('Waiting for approval from your primary mobile.');
        }
      } catch (linkError: any) {
        if (active) {
          setError(linkError?.message || 'Could not start companion pairing.');
          setStatus('');
        }
      }
    })();
    return () => {
      active = false;
    };
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
          setStatus('Companion approved. Opening your encrypted memories...');
          await onLinked(existingLinkedState);
          return;
        }
        const details = await getPendingSyncV2CompanionPairing(context.auth);
        if (
          !details ||
          details.pairing.status === 'EXPIRED' ||
          details.pairing.status === 'REJECTED'
        ) {
          throw new Error('Pairing request expired.');
        }
        if (!canCompleteWebCompanionPairing(details.pairing.status)) {
          return;
        }
        if (active) {
          setError('');
          setIsRestoring(true);
          setStatus('Companion approved. Restoring your encrypted memories...');
        }
        if (!pairingCompletionPromise) {
          pairingCompletionPromise = completeSyncV2CompanionPairing(context.auth).finally(() => {
            pairingCompletionPromise = null;
          });
        }
        const linked = await pairingCompletionPromise;
        if (linked && active) {
          pairingInitializationPromise = null;
          setIsRestoring(true);
          setStatus('Companion approved. Opening your encrypted memories...');
          await onLinked(linked);
        }
      } catch (approvalError: any) {
        if (approvalError?.message?.includes('expired')) {
          pairingInitializationPromise = null;
          if (active) {
            setContext(null);
            setIsRestoring(false);
            setStatus('Pairing expired. Sign in to start a new request.');
          }
        } else if (active) {
          const linkedState = await diaryRepository.getLocalSyncAccountState().catch(() => null);
          if (linkedState) {
            pairingInitializationPromise = null;
            setIsRestoring(true);
            setStatus('Companion approved. Opening your encrypted memories...');
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
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [context, onLinked]);

  const pairingPayload = useMemo(
    () =>
      context
        ? JSON.stringify({
            version: 2,
            protocolVersion: 2,
            sessionId: context.pairing.pairingId,
            pairingCode: context.pairing.pairingCode,
          })
        : '',
    [context],
  );

  const beginSignIn = async () => {
    setIsStarting(true);
    setError('');
    try {
      await startWebGoogleSyncSignIn();
    } catch (signInError: any) {
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
    <main className="app-canvas min-h-screen min-h-[100dvh] overflow-x-hidden bg-brand-bg px-5 py-8 text-brand-text sm:px-8 lg:px-12 lg:py-10">
      <div className="mx-auto grid min-h-[calc(100dvh-4rem)] w-full max-w-[1280px] items-center gap-x-12 gap-y-9 lg:min-h-[calc(100dvh-5rem)] lg:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)] xl:gap-x-20">
        <header className="lg:col-start-1 lg:self-end">
          <div className="flex items-center gap-3">
            <span className="flex h-12 w-12 items-center justify-center rounded-[var(--radius-control)] bg-[var(--color-secondary-container)] text-[var(--color-secondary-on-container)]">
              <BookOpen aria-hidden="true" className="h-5 w-5" />
            </span>
            <p className="app-eyebrow tracking-[0.24em]">{BRAND.tagline}</p>
          </div>
          <h1 className="type-display mt-6 text-[var(--color-secondary-on-container)] sm:text-[4.25rem] lg:text-[4.75rem]">
            {BRAND.wordmark}
          </h1>
          <h2 className="type-section-title mt-5 font-semibold">
            Your story starts on your phone.
          </h2>
          <p className="type-supporting mt-3 max-w-xl text-base">
            Write, protect, and keep your memories on Android. Use the web later as a trusted
            companion.
          </p>
        </header>

        <section
          className="order-3 lg:order-none lg:col-start-1 lg:self-start"
          aria-label={`How ${BRAND.name} works`}
        >
          <div className="grid gap-7 md:grid-cols-[220px_minmax(0,1fr)] md:items-center lg:grid-cols-[240px_minmax(0,1fr)]">
            <figure className="hidden overflow-hidden rounded-[1.75rem] border border-[var(--border-strong)] bg-surface shadow-[var(--shadow-floating)] md:block">
              <img
                src={mobileAppPreview}
                alt={`${BRAND.name} Android app Today screen`}
                className="block aspect-[390/844] w-full object-cover object-top"
              />
              <figcaption className="flex items-center justify-center gap-2 border-t border-[var(--border-subtle)] bg-surface-subtle px-3 py-3 text-xs font-bold text-accent-strong">
                <ShieldCheck aria-hidden="true" className="h-4 w-4" />
                End-to-end encrypted
              </figcaption>
            </figure>

            <ol className="grid gap-5">
              {setupSteps.map(({ title, description, icon: StepIcon }, index) => (
                <li key={title} className="grid grid-cols-[2rem_2.75rem_1fr] items-start gap-3">
                  <span className="mt-1 flex h-7 w-7 items-center justify-center rounded-full bg-[var(--color-secondary-container)] text-xs font-bold text-[var(--color-secondary-on-container)]">
                    {index + 1}
                  </span>
                  <span className="flex h-11 w-11 items-center justify-center rounded-[var(--radius-control)] border border-accent bg-surface text-accent-strong">
                    <StepIcon aria-hidden="true" className="h-5 w-5" />
                  </span>
                  <span>
                    <span className="block text-sm font-bold text-ink">{title}</span>
                    <span className="mt-1 block text-sm leading-relaxed text-ink-secondary">
                      {description}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <aside className="order-2 lg:order-none lg:col-start-2 lg:row-start-1 lg:row-span-2 lg:flex lg:min-h-[720px] lg:items-center lg:border-l lg:border-[var(--border-subtle)] lg:pl-12 xl:pl-20">
          <div className="w-full">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-[var(--color-secondary-container)] text-[var(--color-secondary-on-container)]">
              <SmartphoneDevice aria-hidden="true" className="h-7 w-7" />
            </div>

            {!context ? (
              <div className="mt-7">
                <a
                  href={ANDROID_APP_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-h-12 w-full items-center justify-center gap-3 rounded-[var(--radius-control)] border border-accent bg-accent px-5 py-3 text-sm font-bold text-[var(--color-on-primary)] transition-colors hover:bg-accent-strong"
                >
                  <Download aria-hidden="true" className="h-5 w-5" />
                  Get it on Google Play
                </a>

                <div className="my-6 flex items-center gap-4" aria-hidden="true">
                  <span className="h-px flex-1 bg-[var(--border-subtle)]" />
                  <span className="text-xs font-bold text-ink-tertiary">or</span>
                  <span className="h-px flex-1 bg-[var(--border-subtle)]" />
                </div>

                <div className="hidden items-center gap-4 rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-surface px-5 py-4 sm:flex">
                  <div className="rounded-[var(--radius-control)] bg-white p-2">
                    <QRCodeSVG
                      value={ANDROID_APP_URL}
                      size={64}
                      bgColor="#ffffff"
                      fgColor="#69445e"
                      level="M"
                      title={`QR code for the ${BRAND.name} Google Play listing`}
                    />
                  </div>
                  <div>
                    <p className="text-sm font-bold text-ink">Scan with your phone</p>
                    <p className="mt-1 text-xs leading-relaxed text-ink-secondary">
                      Open your camera and scan to view {BRAND.name} on Google Play.
                    </p>
                  </div>
                </div>

                <div className="my-7 h-px bg-[var(--border-subtle)]" />
                <p className="text-center text-sm font-semibold text-ink-secondary">
                  Already use {BRAND.name} on mobile?
                </p>
                <button
                  type="button"
                  onClick={beginSignIn}
                  disabled={isStarting}
                  className="mt-3 inline-flex min-h-12 w-full items-center justify-center gap-3 rounded-[var(--radius-control)] border border-accent bg-surface px-5 py-3 text-sm font-bold text-accent-strong transition-colors hover:bg-accent-soft disabled:opacity-50"
                >
                  {isStarting ? (
                    <LoaderCircle aria-hidden="true" className="h-5 w-5 animate-spin" />
                  ) : (
                    <GoogleCircle aria-hidden="true" className="h-5 w-5" />
                  )}
                  <span>{isStarting ? 'Opening Google...' : 'Continue with Google'}</span>
                </button>

                {status && (
                  <p
                    className="mt-3 text-center text-xs leading-relaxed text-ink-secondary"
                    role="status"
                  >
                    {status}
                  </p>
                )}
              </div>
            ) : isRestoring ? (
              <div className="mt-8 flex flex-col items-center gap-4 text-center" role="status">
                <LoaderCircle aria-hidden="true" className="h-9 w-9 animate-spin text-accent" />
                <p className="max-w-xs text-sm font-semibold text-ink-secondary">{status}</p>
              </div>
            ) : (
              <div className="mt-8 text-center">
                <p className="text-xs font-bold uppercase tracking-[0.18em] text-accent-strong">
                  Pairing code
                </p>
                <p className="mt-3 font-mono text-5xl font-bold tracking-[0.12em] text-[var(--color-secondary-on-container)]">
                  {context.pairing.pairingCode}
                </p>
                <button
                  type="button"
                  onClick={copyPairing}
                  className="mx-auto mt-5 flex h-11 w-11 items-center justify-center rounded-[var(--radius-control)] border border-[var(--border-strong)] text-accent-strong transition-colors hover:bg-accent-soft"
                  aria-label={copied ? 'Pairing request copied' : 'Copy pairing request'}
                >
                  {copied ? <Check className="h-5 w-5" /> : <Clipboard className="h-5 w-5" />}
                </button>
                <div
                  className="mt-5 flex items-center justify-center gap-2 text-sm font-semibold text-ink-secondary"
                  role="status"
                >
                  <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin text-accent" />
                  <span>{status}</span>
                </div>
              </div>
            )}

            {error && (
              <p
                className="mt-4 text-center text-sm font-semibold text-[var(--danger)]"
                role="alert"
              >
                {error}
              </p>
            )}

            <div className="mt-8 flex items-start gap-3 border-t border-[var(--border-subtle)] pt-6 text-sm leading-relaxed text-ink-secondary">
              <ShieldCheck
                aria-hidden="true"
                className="mt-0.5 h-5 w-5 shrink-0 text-accent-strong"
              />
              <p>Your phone approves every browser before encrypted memories are shared.</p>
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}
