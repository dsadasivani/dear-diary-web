import React, { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertCircle, ArrowLeft, BookOpen, CalendarDays, Check, Delete,
  Cloud, Eye, EyeOff, LoaderCircle, Lock, Moon, ShieldCheck, Sparkles, Sun
} from 'lucide-react';
import { AppSettings, GoogleAccountSession, SecurityConfig, SupabaseAuthSession, SyncAccount } from '../types';
import {
  createCustomRecoveryQuestionId,
  createInitialPinWithRecovery,
  getRecoveryQuestionText,
  hasRecoveryQuestion,
  isValidPin,
  resetPinAfterVerifiedRecovery,
  SECURITY_RECOVERY_QUESTIONS,
  unlockWithPin,
  withRecoveryQuestion,
  verifyRecoveryAnswer,
} from '../domain/security';
import type { PinLength } from '../domain/security';
import { signOutGoogleAuth, startGoogleAuth } from '../utils/googleAuth';
import { diaryRepository } from '../repositories';
import { applyThemePreference, getLocalThemePreference, setLocalThemePreference } from '../utils/themePreference';
import { bootstrapNewMobileAccount } from '../sync/accountBootstrap';
import {
  createConfiguredSupabaseControlPlaneClient,
  getConfiguredSupabaseAnonKey,
  getConfiguredSupabaseUrl,
} from '../sync/config';
import { exchangeGoogleIdTokenForSupabaseSession } from '../sync/supabaseAuth';
import {
  isValidNewRecoveryPassphrase,
  RECOVERY_PASSPHRASE_DIGIT_LENGTH,
  validateRecoveryPassphrase,
} from '../sync/e2eeKeyPackage';

interface LockScreenProps {
  initialSecurity: SecurityConfig;
  initialSettings: AppSettings;
  onSecurityChange: (security: SecurityConfig) => void;
  onThemeChange?: (theme: 'light' | 'dark') => void;
  onUnlock: () => void | Promise<void>;
}

const SANCTUARY_QUOTES = [
  'Your thoughts deserve a safe, quiet space.',
  'Give yourself grace for the things left undone.',
  'In the garden of your mind, let peace grow.',
  'Write what is in your heart; it is always true.',
  'Savor the simple, beautiful, quiet moments.',
  'Every page is a fresh start. Every word is a step home.'
];

const CUSTOM_QUESTION_SELECT_VALUE = 'custom';

const formatGoogleAuthError = (err: any): string => {
  const message = err?.message || '';
  if (message.includes('VITE_GOOGLE_WEB_CLIENT_ID')) {
    return 'Mobile Google sign-in needs VITE_GOOGLE_WEB_CLIENT_ID in .env. Use the Google Cloud OAuth Web application client ID, then rebuild and reinstall the APK.';
  }
  if (err?.code === 'SIGN_IN_CANCELED' || message.includes('SIGN_IN_CANCELED')) {
    return 'Google sign-in was cancelled before it completed.';
  }
  if (message.includes('Drive access')) {
    return 'Google did not grant the requested account access. Please reconnect and approve the permission prompt.';
  }
  if (message.includes('native mobile app')) {
    return message;
  }
  return err?.message || 'Google verification failed.';
};

type SetupStep = 'pin' | 'confirm' | 'recovery';
type RecoveryMode = 'choosing' | 'question' | 'newPin' | null;
type SyncSetupProgressKey = 'connect' | 'verify' | 'prepare' | 'restore' | 'finish';
type SyncSetupAccountMode = 'create' | 'recover';

interface SyncSetupSelection {
  googleSession: GoogleAccountSession;
  supabaseSession: SupabaseAuthSession;
  existingAccount: SyncAccount | null;
  accountMode: SyncSetupAccountMode;
}

const SYNC_SETUP_PROGRESS_STEPS: Array<{ key: SyncSetupProgressKey; label: string }> = [
  { key: 'connect', label: 'Connect' },
  { key: 'verify', label: 'Verify' },
  { key: 'prepare', label: 'Prepare' },
  { key: 'restore', label: 'Restore' },
  { key: 'finish', label: 'Finish' },
];

const syncSetupProgressKeyForMessage = (message: string): SyncSetupProgressKey => {
  const normalized = message.toLowerCase();
  if (normalized.includes('finding your recovery key') || normalized.includes('unlocking your encrypted account')) {
    return 'verify';
  }
  if (
    normalized.includes('restoring diary data') ||
    normalized.includes('encrypting diary snapshot') ||
    normalized.includes('saving diary snapshot')
  ) {
    return 'restore';
  }
  if (
    normalized.includes('personalizing your profile') ||
    normalized.includes('creating encryption keys') ||
    normalized.includes('creating account metadata') ||
    normalized.includes('encrypting recovery key') ||
    normalized.includes('saving recovery key') ||
    normalized.includes('registering this device') ||
    normalized.includes('restoring local recovery state') ||
    normalized.includes('securing recovered account keys')
  ) {
    return 'prepare';
  }
  if (
    normalized.includes('finishing account recovery') ||
    normalized.includes('saving account on this device') ||
    normalized.includes('securing account keys') ||
    normalized.includes('encrypted account')
  ) {
    return 'finish';
  }
  return 'connect';
};

export default function LockScreen({
  initialSecurity,
  initialSettings,
  onSecurityChange,
  onThemeChange,
  onUnlock,
}: LockScreenProps) {
  const [security, setSecurity] = useState<SecurityConfig>(initialSecurity);
  const [pin, setPin] = useState('');
  const [selectedPinLength, setSelectedPinLength] = useState<PinLength>(security.pinLength || 4);
  const [pendingSetupPin, setPendingSetupPin] = useState('');
  const [setupStep, setSetupStep] = useState<SetupStep>('pin');
  const [questionId, setQuestionId] = useState(SECURITY_RECOVERY_QUESTIONS[0]?.id || '');
  const [customRecoveryQuestion, setCustomRecoveryQuestion] = useState('');
  const [recoveryAnswer, setRecoveryAnswer] = useState('');
  const [showRecoveryAnswer, setShowRecoveryAnswer] = useState(false);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [showPin, setShowPin] = useState(false);
  const [shakeTrigger, setShakeTrigger] = useState(false);
  const [requiresRecoverySetup, setRequiresRecoverySetup] = useState(false);
  const [recoveryMode, setRecoveryMode] = useState<RecoveryMode>(null);
  const [isResetting, setIsResetting] = useState(false);
  const [resetPinLength, setResetPinLength] = useState<PinLength>(security.pinLength || 4);
  const [resetNewPin, setResetNewPin] = useState('');
  const [resetConfirmPin, setResetConfirmPin] = useState('');
  const [recoveryVerifiedBy, setRecoveryVerifiedBy] = useState<'question' | 'google' | null>(null);
  const [screenMode, setScreenMode] = useState<'ambient' | 'keypad'>(() => {
    const isDesktopViewport = typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches;
    return initialSecurity.isPinCreated && !isDesktopViewport ? 'ambient' : 'keypad';
  });
  const [time, setTime] = useState('');
  const [date, setDate] = useState('');
  const [quoteIndex, setQuoteIndex] = useState(0);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => getLocalThemePreference(initialSettings.theme || 'light'));
  const [showBackupChoice, setShowBackupChoice] = useState(false);
  const [isLinkingBackup, setIsLinkingBackup] = useState(false);
  const [recoveryPassphrase, setRecoveryPassphrase] = useState('');
  const [confirmRecoveryPassphrase, setConfirmRecoveryPassphrase] = useState('');
  const [showRecoveryPassphrase, setShowRecoveryPassphrase] = useState(false);
  const [syncSetupSelection, setSyncSetupSelection] = useState<SyncSetupSelection | null>(null);

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      setTime(`${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`);
      setDate(now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }));
    };
    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const quoteInterval = setInterval(() => {
      setQuoteIndex(prev => (prev + 1) % SANCTUARY_QUOTES.length);
    }, 12000);
    return () => clearInterval(quoteInterval);
  }, []);

  useEffect(() => {
    applyThemePreference(theme);
  }, [theme]);

  const triggerHaptic = (pattern: number | number[]) => {
    if (typeof window !== 'undefined' && typeof window.navigator?.vibrate === 'function') {
      try {
        window.navigator.vibrate(pattern);
      } catch (e) {
        console.warn('Haptic feedback not supported:', e);
      }
    }
  };

  const fail = (message: string) => {
    setError(message);
    setSuccessMsg('');
    setShakeTrigger(true);
    triggerHaptic([60, 40, 60]);
    setTimeout(() => setShakeTrigger(false), 500);
  };

  const completeUnlock = async (config: SecurityConfig = security, verifiedPin = '') => {
    if (config.isPinCreated && !hasRecoveryQuestion(config)) {
      setSecurity(config);
      if (verifiedPin) setPendingSetupPin(verifiedPin);
      setRequiresRecoverySetup(true);
      setScreenMode('keypad');
      setPin('');
      setError('');
      setSuccessMsg('PIN verified. Set a recovery question to continue.');
      return;
    }

    const syncAccount = await diaryRepository.getLocalSyncAccountState();
    if (!syncAccount) {
      if (!verifiedPin && !pendingSetupPin) {
        setScreenMode('keypad');
        setPin('');
        setError('');
        setSuccessMsg('Enter your PIN to connect this diary to its encrypted account.');
        return;
      }
      setPendingSetupPin(verifiedPin || pendingSetupPin);
      setShowBackupChoice(true);
      setScreenMode('keypad');
      setPin('');
      setError('');
      setSuccessMsg('Local diary verified. Connect it to your encrypted account.');
      return;
    }

    setSuccessMsg('Access Granted');
    triggerHaptic([40, 40]);
    setTimeout(() => void onUnlock(), 450);
  };

  const handleKeyPress = (num: string) => {
    triggerHaptic(10);
    const maxLength = security.isPinCreated ? (security.pinLength || 8) : selectedPinLength;
    if (pin.length < maxLength) {
      setError('');
      setPin(prev => prev + num);
    }
  };

  const handleBackspace = () => {
    triggerHaptic(12);
    setPin(prev => prev.slice(0, -1));
  };

  const handleClear = () => {
    triggerHaptic(20);
    setPin('');
    setError('');
  };

  const handleSubmit = async () => {
    const requiredLength = security.isPinCreated ? security.pinLength : selectedPinLength;
    if (!isValidPin(pin, requiredLength)) {
      fail(`PIN must be exactly ${requiredLength || '4 or 8'} digits.`);
      return;
    }

    if (!security.isPinCreated) {
      if (setupStep === 'pin') {
        setPendingSetupPin(pin);
        setPin('');
        setSetupStep('confirm');
        setSuccessMsg('Confirm the same PIN.');
        return;
      }

      if (setupStep === 'confirm') {
        if (pin !== pendingSetupPin) {
          setPendingSetupPin('');
          setPin('');
          setSetupStep('pin');
          fail('PINs do not match. Start again.');
          return;
        }
        setPin('');
        setSetupStep('recovery');
        setSuccessMsg('Add your recovery question.');
        return;
      }
    } else {
      const unlockedSecurity = unlockWithPin(security, pin);
      if (unlockedSecurity) {
        await diaryRepository.saveSecurityConfig(unlockedSecurity);
        setSecurity(unlockedSecurity);
        onSecurityChange(unlockedSecurity);
        await completeUnlock(unlockedSecurity, pin);
      } else {
        setPin('');
        fail('Incorrect security PIN.');
      }
    }
  };

  const getRecoveryQuestionPayload = () => {
    if (questionId === CUSTOM_QUESTION_SELECT_VALUE) {
      return {
        id: createCustomRecoveryQuestionId(),
        text: customRecoveryQuestion.trim()
      };
    }

    return { id: questionId, text: undefined };
  };

  const handleSaveInitialRecovery = async () => {
    try {
      const question = getRecoveryQuestionPayload();
      const configuredSecurity = createInitialPinWithRecovery(
        security,
        pendingSetupPin,
        question.id,
        recoveryAnswer,
        question.text,
      );
      const syncAccount = await diaryRepository.getLocalSyncAccountState();
      if (syncAccount) {
        const updated = {
          ...configuredSecurity,
          linkedGoogleUserId: syncAccount.googleUserId,
          linkedGoogleEmail: syncAccount.googleEmail,
          linkedGoogleBoundAt: Date.now(),
        };
        await diaryRepository.saveSecurityConfig(updated);
        setSecurity(updated);
        onSecurityChange(updated);
        setSuccessMsg('Companion security PIN created.');
        await completeUnlock(updated);
        return;
      }
      setSuccessMsg('Local PIN recovery is ready. Connect Google to create or restore your encrypted account.');
      setSyncSetupSelection(null);
      setRecoveryPassphrase('');
      setConfirmRecoveryPassphrase('');
      setShowBackupChoice(true);
    } catch (err: any) {
      fail(err?.message || 'Could not save recovery question.');
    }
  };

  const resetGoogleSetupSelection = () => {
    setSyncSetupSelection(null);
    setRecoveryPassphrase('');
    setConfirmRecoveryPassphrase('');
    setShowRecoveryPassphrase(false);
    setError('');
    setSuccessMsg('Connect the Google account you want to use for encrypted sync.');
  };

  const handleConnectGoogleAccount = async () => {
    setIsLinkingBackup(true);
    setError('');
    setSuccessMsg('Opening Google account...');
    try {
      const session = await startGoogleAuth('sync');
      if (!session.idToken) throw new Error('Google did not return an ID token for Supabase sign-in.');
      setSuccessMsg('Signing in to sync service...');
      const supabaseSession = await exchangeGoogleIdTokenForSupabaseSession({
        supabaseUrl: getConfiguredSupabaseUrl(),
        anonKey: getConfiguredSupabaseAnonKey(),
        googleIdToken: session.idToken,
      });
      setSuccessMsg('Checking Dear Diary account...');
      const controlPlane = createConfiguredSupabaseControlPlaneClient(supabaseSession.accessToken);
      const existingAccount = await controlPlane.lookupCurrentGoogleAccount();
      const accountMode: SyncSetupAccountMode = existingAccount ? 'recover' : 'create';
      setSyncSetupSelection({
        googleSession: session,
        supabaseSession,
        existingAccount,
        accountMode,
      });
      setRecoveryPassphrase('');
      setConfirmRecoveryPassphrase('');
      setShowRecoveryPassphrase(false);
      setSuccessMsg(existingAccount
        ? 'Encrypted account found. Enter its recovery passphrase to restore this diary.'
        : 'No encrypted account found. Create an 8-digit recovery passphrase for this account.');
    } catch (err: any) {
      const message = err?.message || '';
      if (
        message.includes('Supabase Auth') ||
        message.includes('Supabase sign-in') ||
        message.includes('Supabase control-plane') ||
        message.includes('Missing VITE_SUPABASE')
      ) {
        fail(message);
      } else {
        fail(formatGoogleAuthError(err));
      }
    } finally {
      setIsLinkingBackup(false);
    }
  };

  const handleCompleteGoogleSetup = async () => {
    if (!syncSetupSelection) {
      await handleConnectGoogleAccount();
      return;
    }

    setIsLinkingBackup(true);
    setError('');
    try {
      if (syncSetupSelection.accountMode === 'create') {
        validateRecoveryPassphrase(recoveryPassphrase);
        if (recoveryPassphrase !== confirmRecoveryPassphrase) {
          throw new Error('Recovery passphrases do not match.');
        }
      } else if (!recoveryPassphrase) {
        throw new Error('Enter the recovery passphrase for this account.');
      }

      setSuccessMsg(syncSetupSelection.accountMode === 'recover'
        ? 'Preparing account recovery...'
        : 'Preparing encrypted account...');
      const controlPlane = createConfiguredSupabaseControlPlaneClient(syncSetupSelection.supabaseSession.accessToken);
      const question = getRecoveryQuestionPayload();
      const result = await bootstrapNewMobileAccount({
        googleSession: syncSetupSelection.googleSession,
        supabaseSession: syncSetupSelection.supabaseSession,
        recoveryPassphrase,
        localPin: pendingSetupPin,
        recoveryQuestion: {
          questionId: question.id,
          answer: recoveryAnswer,
          questionText: question.text,
        },
        repository: diaryRepository,
        controlPlane,
        accountMode: syncSetupSelection.accountMode,
        preflightAccount: syncSetupSelection.existingAccount,
        onProgress: setSuccessMsg,
      });
      const updatedSecurity = await diaryRepository.getSecurityConfig();
      setSecurity(updatedSecurity);
      onSecurityChange(updatedSecurity);
      setSuccessMsg(result.mode === 'recovered' ? 'Encrypted account recovered on this device.' : 'Encrypted account created.');
      setTimeout(() => void onUnlock(), 450);
    } catch (err: any) {
      const message = err?.message || '';
      if (
        message.includes('Supabase Auth') ||
        message.includes('Supabase sign-in') ||
        message.includes('Supabase control-plane') ||
        message.includes('Missing VITE_SUPABASE')
      ) {
        fail(message);
      } else {
        fail(formatGoogleAuthError(err));
      }
    } finally {
      setIsLinkingBackup(false);
    }
  };

  const handleSaveMigrationRecovery = async () => {
    try {
      const question = getRecoveryQuestionPayload();
      const updated = withRecoveryQuestion(security, question.id, recoveryAnswer, question.text);
      await diaryRepository.saveSecurityConfig(updated);
      setSecurity(updated);
      onSecurityChange(updated);
      setRequiresRecoverySetup(false);
      setSuccessMsg('Recovery question saved.');
      await completeUnlock(updated, pendingSetupPin);
    } catch (err: any) {
      fail(err?.message || 'Could not save recovery question.');
    }
  };

  const handleVerifySecurityAnswer = () => {
    if (verifyRecoveryAnswer(security, recoveryAnswer)) {
      setRecoveryVerifiedBy('question');
      setRecoveryMode('newPin');
      setRecoveryAnswer('');
      setError('');
      setSuccessMsg('Security answer verified. Choose a new PIN.');
    } else {
      fail('Security answer did not match.');
    }
  };

  const completeGoogleResetVerification = async (credential: GoogleAccountSession) => {
    const linkedGoogleUserId = security.linkedGoogleUserId || security.linkedGoogleUid;
    if (credential.userId !== linkedGoogleUserId) {
      await signOutGoogleAuth();
      fail(`Use ${security.linkedGoogleEmail || 'the linked Google account'} to reset this PIN.`);
      return;
    }
    setRecoveryVerifiedBy('google');
    setRecoveryMode('newPin');
    setSuccessMsg('Google account verified. Choose a new PIN.');
  };

  const handleVerifyGoogleReset = async () => {
    if (!security.linkedGoogleUserId && !security.linkedGoogleUid) return;
    setIsResetting(true);
    setError('');
    setSuccessMsg('Opening Google verification...');
    try {
      const credential = await startGoogleAuth('pin-reset');
      await completeGoogleResetVerification(credential);
    } catch (err: any) {
      console.error(err);
      fail(formatGoogleAuthError(err));
    } finally {
      setIsResetting(false);
    }
  };

  const handleResetPin = async () => {
    if (!recoveryVerifiedBy) {
      fail('Verify a recovery method first.');
      return;
    }
    if (!isValidPin(resetNewPin, resetPinLength)) {
      fail(`New PIN must be exactly ${resetPinLength} digits.`);
      return;
    }
    if (resetNewPin !== resetConfirmPin) {
      fail('New PINs do not match.');
      return;
    }

    try {
      const updated = resetPinAfterVerifiedRecovery(security, resetNewPin);
      await diaryRepository.saveSecurityConfig(updated);
      setSecurity(updated);
      onSecurityChange(updated);
      setRecoveryMode(null);
      setRecoveryVerifiedBy(null);
      setResetNewPin('');
      setResetConfirmPin('');
      setSuccessMsg('PIN reset successfully.');
      await completeUnlock(updated);
    } catch (err: any) {
      fail(err?.message || 'Could not reset PIN.');
    }
  };

  const toggleTheme = () => {
    const nextTheme: 'light' | 'dark' = theme === 'light' ? 'dark' : 'light';
    setTheme(nextTheme);
    setLocalThemePreference(nextTheme);
    onThemeChange?.(nextTheme);
    triggerHaptic(15);
  };

  const syncSetupMode = syncSetupSelection?.accountMode;
  const isCreatingSyncAccount = syncSetupMode === 'create';
  const isRecoveringSyncAccount = syncSetupMode === 'recover';
  const canSubmitSyncSetup = syncSetupSelection
    ? isRecoveringSyncAccount
      ? recoveryPassphrase.length > 0
      : isValidNewRecoveryPassphrase(recoveryPassphrase) && recoveryPassphrase === confirmRecoveryPassphrase
    : true;

  const setupTitle = showBackupChoice
    ? !syncSetupSelection
      ? 'Connect Google Account'
      : isRecoveringSyncAccount
        ? 'Restore Encrypted Account'
        : 'Create Recovery Passphrase'
    : requiresRecoverySetup
    ? 'Add Recovery Question'
    : setupStep === 'recovery'
      ? 'Add Recovery Question'
      : setupStep === 'confirm'
        ? 'Confirm Security PIN'
        : security.isPinCreated
          ? 'Enter Security PIN'
          : 'Setup Security PIN';

  const setupCopy = showBackupChoice
    ? !syncSetupSelection
      ? 'Connect Google first so Dear Diary can check whether this account already has encrypted data.'
      : isRecoveringSyncAccount
        ? `Encrypted data was found for ${syncSetupSelection.googleSession.email || 'this Google account'}. Enter the recovery passphrase you created earlier.`
        : `No encrypted data was found for ${syncSetupSelection.googleSession.email || 'this Google account'}. Create an ${RECOVERY_PASSPHRASE_DIGIT_LENGTH}-digit recovery passphrase.`
    : requiresRecoverySetup
    ? 'Your PIN is verified. Add a security question before continuing.'
    : setupStep === 'recovery'
      ? 'This lets you reset your PIN while staying completely offline.'
      : setupStep === 'confirm'
        ? `Enter the same ${selectedPinLength}-digit PIN again.`
        : security.isPinCreated
          ? `Enter your ${security.pinLength || '4 or 8'}-digit PIN to unlock your diary.`
          : 'Choose a 4-digit or 8-digit PIN.';

  const activeBgClass = theme === 'dark'
    ? 'bg-gradient-to-tr from-[#100F10] via-[#21191C] to-[#151214]'
    : 'bg-gradient-to-tr from-[#FAF7F2] via-[#FFF8F4] to-[#F4EFE7]';

  const showRecoveryForm = !showBackupChoice && (requiresRecoverySetup || setupStep === 'recovery');
  const isCustomRecoveryQuestion = questionId === CUSTOM_QUESTION_SELECT_VALUE;
  const canSaveRecoveryQuestion = !!recoveryAnswer.trim() && (!isCustomRecoveryQuestion || !!customRecoveryQuestion.trim());
  const visiblePinLength = security.isPinCreated ? (security.pinLength || (pin.length > 4 ? 8 : 4)) : selectedPinLength;
  const accountSetupProgressMessage = successMsg || 'Opening Google account...';
  const accountSetupProgressKey = syncSetupProgressKeyForMessage(accountSetupProgressMessage);
  const accountSetupProgressIndex = Math.max(
    0,
    SYNC_SETUP_PROGRESS_STEPS.findIndex(step => step.key === accountSetupProgressKey),
  );
  const accountSetupProgressDetail = accountSetupProgressKey === 'restore'
    ? 'Large diaries can take a little while to decrypt and import.'
    : 'Keep this screen open while setup finishes.';

  return (
    <div className={`min-h-screen min-h-[100dvh] w-screen ${activeBgClass} text-brand-text flex flex-col items-center justify-between relative overflow-hidden font-sans select-none px-6 py-6 transition-all duration-700 lg:justify-center lg:px-8 lg:py-8`}>
      <div className="absolute inset-0 z-0 pointer-events-none overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(255,255,255,0.58),transparent_42%)] dark:bg-[radial-gradient(circle_at_50%_0%,rgba(255,255,255,0.08),transparent_40%)]" />
        <motion.div animate={{ scale: [1, 1.08, 1], x: [0, 18, 0], y: [0, -18, 0] }} transition={{ duration: 18, repeat: Infinity, ease: 'easeInOut' }} className="absolute top-[-22%] left-[-16%] h-[42rem] w-[42rem] rounded-full bg-brand-pink/10 blur-[140px] dark:bg-brand-pink/16" />
        <motion.div animate={{ scale: [1, 1.1, 1], x: [0, -24, 0], y: [0, 24, 0] }} transition={{ duration: 24, repeat: Infinity, ease: 'easeInOut', delay: 2 }} className="absolute bottom-[-24%] right-[-12%] h-[44rem] w-[44rem] rounded-full bg-brand-sage/10 blur-[160px] dark:bg-brand-sage/14" />
        <div className="absolute inset-y-0 left-0 hidden w-1/2 bg-brand-blush-light/28 dark:bg-[#2A1720]/34 lg:block" />
        <div className="absolute inset-y-0 left-1/2 hidden w-px bg-brand-border/45 dark:bg-white/10 lg:block" />
      </div>

      <section className="pointer-events-none absolute inset-y-0 left-0 z-10 hidden w-1/2 items-center justify-center px-10 lg:flex xl:px-16">
        <motion.div
          initial={{ opacity: 0, x: -18 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
          className="w-full max-w-[460px] text-center"
        >
          <div className="select-none">
            <p className="font-serif-diary text-[5.75rem] font-semibold leading-none tracking-tight text-brand-plum/95 dark:text-[#ECE6E1] xl:text-[6.75rem] 2xl:text-[7.15rem]">{time}</p>
            <p className="mt-5 flex items-center justify-center gap-2 text-sm font-semibold uppercase tracking-[0.18em] text-brand-text-muted dark:text-[#EADCD1]/68">
              <CalendarDays className="h-3.5 w-3.5 text-brand-pink/80" />
              {date}
            </p>
          </div>
          <div className="mx-auto mt-12 h-px w-16 bg-brand-border dark:bg-white/18" />
          <div className="mx-auto mt-10 max-w-md">
            <p className="font-serif-diary text-2xl italic leading-snug text-brand-plum/90 dark:text-[#ECE6E1]/90">
              "{SANCTUARY_QUOTES[quoteIndex]}"
            </p>
            <p className="mt-3 text-lg font-medium text-brand-text-muted dark:text-[#EADCD1]/62">- Sanctuary Note</p>
            <button onClick={(e) => { e.stopPropagation(); setQuoteIndex(prev => (prev + 1) % SANCTUARY_QUOTES.length); }} className="pointer-events-auto mt-5 inline-flex items-center gap-2 rounded-full border border-brand-border/50 bg-white/38 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.16em] text-brand-text-muted transition-all hover:border-brand-pink/35 hover:text-brand-pink dark:border-white/10 dark:bg-white/5" title="Cycle note">
              <Sparkles className="h-3 w-3" />
              Another note
            </button>
          </div>
          <div className="mt-16 flex items-center justify-center gap-2 text-xs font-semibold text-brand-text-muted dark:text-[#EADCD1]/62">
            <ShieldCheck className="h-4 w-4 text-brand-sage/85" />
            <span>Private by default. Encrypted when synced.</span>
          </div>
        </motion.div>
      </section>

      <header className="w-full max-w-sm lg:absolute lg:left-8 lg:right-auto lg:top-8 lg:max-w-none xl:left-10 flex justify-between items-center z-10">
        <div className="flex items-center gap-2 bg-white/55 dark:bg-white/[0.06] backdrop-blur-xl px-3.5 py-1.5 rounded-full border border-brand-border/50 dark:border-white/10 shadow-sm">
          <BookOpen className="w-3.5 h-3.5 text-brand-pink" />
          <span className="text-[9px] font-bold uppercase tracking-[0.2em] text-[#3E2429] dark:text-[#EADCD1]">Dear Diary</span>
        </div>
        <motion.button onClick={toggleTheme} whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }} className="w-9 h-9 rounded-full bg-white/55 dark:bg-white/[0.06] border border-brand-border/50 dark:border-white/10 backdrop-blur-xl flex items-center justify-center text-brand-plum hover:text-brand-pink transition-colors shadow-sm cursor-pointer lg:fixed lg:right-8 lg:top-8" title={`Switch to ${theme === 'light' ? 'Dark' : 'Light'} Mode`}>
          {theme === 'light' ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4 text-amber-200" />}
        </motion.button>
      </header>

      <main className="w-full max-w-sm lg:absolute lg:inset-y-0 lg:left-1/2 lg:ml-0 lg:mr-0 lg:w-1/2 lg:max-w-none lg:flex-grow-0 lg:px-10 xl:px-16 flex-grow flex flex-col justify-center items-center z-10 relative">
        <AnimatePresence mode="wait">
          {screenMode === 'ambient' ? (
            <motion.div key="ambient" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, y: -32, scale: 0.98 }} transition={{ duration: 0.4 }} className="w-full flex flex-col items-center text-center justify-between h-[65vh] sm:h-[70vh] py-4 lg:h-auto lg:max-w-[420px] lg:justify-center lg:gap-7 lg:p-0">
              <div className="w-full max-w-[310px] mt-3 select-none px-5 py-5 lg:hidden">
                <h2 className="font-serif-diary text-[4.75rem] font-bold text-brand-plum dark:text-[#ECE6E1] leading-none">{time}</h2>
                <div className="mt-3 inline-flex items-center justify-center gap-2 text-[12px] font-bold text-brand-text-muted dark:text-[#EADCD1]/80">
                  <CalendarDays className="w-3.5 h-3.5 text-brand-pink" />
                  <span>{date}</span>
                </div>
              </div>

              <div className="hidden flex-col items-center gap-2 lg:flex">
                <span className="flex h-[3.25rem] w-[3.25rem] items-center justify-center rounded-2xl border border-brand-border/55 bg-white/50 text-brand-pink shadow-sm backdrop-blur-xl dark:border-white/10 dark:bg-white/5">
                  <BookOpen className="h-5 w-5" />
                </span>
                <h1 className="font-serif-diary text-3xl font-semibold text-brand-plum dark:text-[#ECE6E1]">Locked</h1>
                <p className="max-w-[250px] text-xs font-medium leading-relaxed text-brand-text-muted dark:text-[#EADCD1]/65">Unlock when you are ready to return to your private writing space.</p>
              </div>

              <div className="flex flex-col items-center gap-4">
                <motion.button onClick={() => { triggerHaptic(15); setScreenMode('keypad'); }} whileHover={{ scale: 1.025 }} whileTap={{ scale: 0.97 }} className="flex flex-col items-center gap-2.5 group">
                  <div className="w-16 h-16 rounded-full bg-white/70 dark:bg-white/[0.06] border border-brand-border/65 dark:border-white/10 backdrop-blur-md flex items-center justify-center shadow-[0_16px_45px_rgba(62,36,41,0.1)] relative">
                    <Lock className="w-6 h-6 text-brand-plum/85 dark:text-brand-text/80 group-hover:text-brand-pink transition-colors stroke-[1.5]" />
                  </div>
                  <span className="text-[10px] font-bold tracking-[0.2em] text-brand-text-muted uppercase">Tap to Unlock</span>
                </motion.button>
              </div>

              <div className="w-full max-w-xs bg-white dark:bg-[#1A1517]/35 border border-brand-border dark:border-white/10 px-4 py-4 rounded-2xl shadow-md text-center flex flex-col gap-2 lg:hidden">
                <p className="text-[9px] font-bold tracking-[0.2em] text-brand-pink uppercase">Sanctuary Note</p>
                <p className="font-serif-diary text-base text-brand-plum dark:text-brand-text leading-snug">{SANCTUARY_QUOTES[quoteIndex]}</p>
                <button onClick={(e) => { e.stopPropagation(); setQuoteIndex(prev => (prev + 1) % SANCTUARY_QUOTES.length); }} className="self-center p-1 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 text-brand-text-muted hover:text-brand-pink transition-all" title="Cycle Inspiration">
                  <Sparkles className="w-3.5 h-3.5 animate-pulse" />
                </button>
              </div>
            </motion.div>
          ) : (
            <motion.div key="keypad" initial={{ opacity: 0, y: 80 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 80 }} transition={{ type: 'spring', damping: 25, stiffness: 180 }} className="w-full lg:max-w-[440px]">
              <motion.div animate={shakeTrigger ? { x: [-10, 10, -8, 8, -5, 5, 0] } : {}} transition={{ duration: 0.4 }} className="w-full p-4 sm:p-5 lg:p-0 flex flex-col gap-3.5 lg:gap-6 relative overflow-visible">
                <div className="pointer-events-none absolute inset-x-10 top-0 hidden h-px bg-gradient-to-r from-transparent via-white/80 to-transparent dark:via-white/20" />
                {security.isPinCreated && !requiresRecoverySetup && (
                  <button onClick={() => { triggerHaptic(10); setScreenMode('ambient'); setPin(''); setError(''); }} className="absolute top-2 left-2 p-2 rounded-full hover:bg-white/40 dark:hover:bg-white/10 text-brand-text-muted hover:text-brand-plum transition-colors lg:hidden" title="Back to Clock">
                    <ArrowLeft className="w-4 h-4 stroke-[2.5]" />
                  </button>
                )}

                <div className="text-center space-y-1 sm:space-y-1.5 flex flex-col items-center mt-1">
                  <div className="relative w-12 h-12 sm:w-14 sm:h-14 lg:h-20 lg:w-20 lg:rounded-full rounded-2xl bg-white/70 dark:bg-white/[0.06] border border-brand-border/60 dark:border-white/10 shadow-sm flex items-center justify-center backdrop-blur-md">
                    <BookOpen className="w-5.5 h-5.5 sm:w-6.5 sm:h-6.5 text-brand-pink" />
                    <span className="absolute -right-1 -top-1 hidden h-7 w-7 items-center justify-center rounded-full bg-brand-plum text-white shadow-md dark:bg-[#151214] lg:flex">
                      <Lock className="h-3.5 w-3.5" />
                    </span>
                  </div>
                  <div className="space-y-0.5">
                    <h1 className="font-serif-diary text-xl sm:text-2xl lg:text-3xl text-[#2C1D21] dark:text-[#ECE6E1] font-bold tracking-tight">
                      <span className="lg:hidden">Dear Diary</span>
                      <span className="hidden lg:inline">{security.isPinCreated && !requiresRecoverySetup ? 'Welcome Back' : setupTitle}</span>
                    </h1>
                    <p className="text-[8px] sm:text-[9px] lg:text-base lg:font-normal lg:normal-case lg:tracking-normal font-bold tracking-[0.25em] text-brand-pink/85 dark:text-brand-pink-dark uppercase">
                      <span className="lg:hidden">Private Access</span>
                      <span className="hidden lg:inline text-brand-text-muted dark:text-[#EADCD1]/70">{security.isPinCreated && !requiresRecoverySetup ? 'Your sanctuary is currently locked.' : setupCopy}</span>
                    </p>
                  </div>
                </div>

                <div className="text-center py-1 border-b border-brand-border/45 pb-2 lg:hidden">
                  <span className="inline-flex p-1.5 bg-brand-pink/10 text-brand-pink rounded-xl mb-1">
                    <ShieldCheck className="w-4 h-4" />
                  </span>
                  <h2 className="text-xs sm:text-sm font-bold text-[#2C1D21] dark:text-[#ECE6E1]">{setupTitle}</h2>
                  <p className="text-[10px] sm:text-[11px] text-brand-text-muted mt-1 leading-relaxed max-w-[260px] mx-auto">{setupCopy}</p>
                </div>

                {showBackupChoice ? (
                  <div className="flex flex-col gap-3">
                    {!syncSetupSelection ? (
                      <div className="rounded-2xl border border-brand-sage/20 bg-brand-sage/8 p-3 text-left text-[10px] leading-relaxed text-brand-text-muted">
                        Dear Diary will use Google to check for existing encrypted data before asking for a recovery passphrase.
                      </div>
                    ) : (
                      <>
                        <div className="rounded-2xl border border-brand-sage/20 bg-white/50 p-3 text-left dark:bg-white/[0.04]">
                          <p className="text-[9px] font-black uppercase tracking-[0.16em] text-brand-sage">
                            Google Account
                          </p>
                          <p className="mt-1 truncate text-xs font-bold text-brand-plum dark:text-brand-text">
                            {syncSetupSelection.googleSession.email || 'Connected Google account'}
                          </p>
                          {!isLinkingBackup && (
                            <button
                              type="button"
                              onClick={resetGoogleSetupSelection}
                              className="mt-2 text-[10px] font-bold text-brand-pink hover:text-brand-pink-dark"
                            >
                              Use a different Google account
                            </button>
                          )}
                        </div>
                        <label className="flex flex-col gap-1 text-left">
                          <span className="text-[10px] font-bold text-brand-sage uppercase tracking-wider">
                            {isRecoveringSyncAccount ? 'Existing Recovery Passphrase' : 'New 8-Digit Recovery Passphrase'}
                          </span>
                          <div className="relative">
                            <input
                              type={showRecoveryPassphrase ? 'text' : 'password'}
                              inputMode={isCreatingSyncAccount ? 'numeric' : undefined}
                              autoComplete={isRecoveringSyncAccount ? 'current-password' : 'new-password'}
                              maxLength={isCreatingSyncAccount ? RECOVERY_PASSPHRASE_DIGIT_LENGTH : undefined}
                              value={recoveryPassphrase}
                              onChange={(event) => {
                                setRecoveryPassphrase(isCreatingSyncAccount
                                  ? event.target.value.replace(/\D/g, '').slice(0, RECOVERY_PASSPHRASE_DIGIT_LENGTH)
                                  : event.target.value);
                                setError('');
                              }}
                              disabled={isLinkingBackup}
                              className="w-full bg-white dark:bg-[#1A1517]/40 border border-brand-border rounded-xl p-2.5 pr-10 text-xs text-brand-plum dark:text-brand-text focus:outline-none focus:border-brand-pink disabled:opacity-60"
                              placeholder={isRecoveringSyncAccount ? 'Passphrase from earlier setup' : `${RECOVERY_PASSPHRASE_DIGIT_LENGTH} digits`}
                            />
                            <button type="button" onClick={() => setShowRecoveryPassphrase(prev => !prev)} disabled={isLinkingBackup} className="absolute inset-y-0 right-2 flex items-center text-brand-sage hover:text-brand-pink disabled:opacity-50" title={showRecoveryPassphrase ? 'Hide passphrase' : 'Show passphrase'}>
                              {showRecoveryPassphrase ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                            </button>
                          </div>
                        </label>
                        {isCreatingSyncAccount && (
                          <label className="flex flex-col gap-1 text-left">
                            <span className="text-[10px] font-bold text-brand-sage uppercase tracking-wider">Confirm 8-Digit Passphrase</span>
                            <input
                              type={showRecoveryPassphrase ? 'text' : 'password'}
                              inputMode="numeric"
                              autoComplete="new-password"
                              maxLength={RECOVERY_PASSPHRASE_DIGIT_LENGTH}
                              value={confirmRecoveryPassphrase}
                              onChange={(event) => {
                                setConfirmRecoveryPassphrase(event.target.value.replace(/\D/g, '').slice(0, RECOVERY_PASSPHRASE_DIGIT_LENGTH));
                                setError('');
                              }}
                              disabled={isLinkingBackup}
                              className="w-full bg-white dark:bg-[#1A1517]/40 border border-brand-border rounded-xl p-2.5 text-xs text-brand-plum dark:text-brand-text focus:outline-none focus:border-brand-pink disabled:opacity-60"
                              placeholder="Type it again"
                            />
                          </label>
                        )}
                        <div className="rounded-2xl border border-brand-pink/15 bg-brand-pink/5 p-3 text-left text-[10px] leading-relaxed text-brand-text-muted">
                          {isRecoveringSyncAccount
                            ? 'Use the recovery passphrase you created when this encrypted account was first set up.'
                            : 'This 8-digit recovery passphrase protects your account root key. Keep it somewhere safe.'}
                        </div>
                      </>
                    )}
                    <AnimatePresence initial={false}>
                      {isLinkingBackup && (
                        <motion.div
                          initial={{ opacity: 0, y: 8 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -6 }}
                          className="rounded-2xl border border-brand-sage/25 bg-white/58 p-3 text-left shadow-sm backdrop-blur-md dark:bg-white/[0.04]"
                        >
                          <div className="flex items-start gap-2.5">
                            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-sage/12 text-brand-sage">
                              <LoaderCircle className="h-4 w-4 animate-spin" />
                            </span>
                            <div className="min-w-0">
                              <p className="text-[11px] font-extrabold text-brand-plum dark:text-brand-text">{accountSetupProgressMessage}</p>
                              <p className="mt-0.5 text-[10px] font-semibold leading-relaxed text-brand-text-muted">{accountSetupProgressDetail}</p>
                            </div>
                          </div>
                          <div className="mt-3 grid grid-cols-5 gap-1.5">
                            {SYNC_SETUP_PROGRESS_STEPS.map((step, index) => {
                              const isComplete = index < accountSetupProgressIndex;
                              const isActive = index === accountSetupProgressIndex;
                              return (
                                <div key={step.key} className="min-w-0">
                                  <div className={`mx-auto flex h-6 w-6 items-center justify-center rounded-full border text-[9px] font-black transition-colors ${
                                    isComplete
                                      ? 'border-brand-sage bg-brand-sage text-white'
                                      : isActive
                                        ? 'border-brand-pink bg-brand-pink/10 text-brand-pink'
                                        : 'border-brand-border bg-white/45 text-brand-text-muted dark:bg-white/[0.03]'
                                  }`}>
                                    {isComplete ? <Check className="h-3 w-3" /> : isActive ? <LoaderCircle className="h-3 w-3 animate-spin" /> : index + 1}
                                  </div>
                                  <p className={`mt-1 truncate text-center text-[8px] font-black uppercase tracking-[0.08em] ${
                                    isComplete || isActive ? 'text-brand-sage' : 'text-brand-text-muted/70'
                                  }`}>{step.label}</p>
                                </div>
                              );
                            })}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                    <button
                      onClick={syncSetupSelection ? handleCompleteGoogleSetup : handleConnectGoogleAccount}
                      disabled={isLinkingBackup || !canSubmitSyncSetup}
                      aria-busy={isLinkingBackup}
                      className="w-full py-3.5 rounded-2xl bg-brand-pink text-white font-bold text-xs uppercase tracking-widest shadow-md disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                      {isLinkingBackup ? <LoaderCircle className="w-4 h-4 animate-spin" /> : <Cloud className="w-4 h-4" />}
                      {isLinkingBackup
                        ? syncSetupSelection ? 'Setting Up...' : 'Connecting...'
                        : !syncSetupSelection ? 'Connect Google Account' : isRecoveringSyncAccount ? 'Restore Encrypted Account' : 'Create Encrypted Account'}
                    </button>
                    {error && (
                      <p className="text-[11px] font-bold text-brand-rose flex justify-center items-center gap-1">
                        <AlertCircle className="w-3 h-3" />
                        <span>{error}</span>
                      </p>
                    )}
                    {successMsg && !error && !isLinkingBackup && (
                      <p className="text-[11px] font-bold text-brand-sage flex justify-center items-center gap-1">
                        <Check className="w-3 h-3" />
                        <span>{successMsg}</span>
                      </p>
                    )}
                  </div>
                ) : showRecoveryForm ? (
                  <div className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-left">
                      <span className="text-[10px] font-bold text-brand-sage uppercase tracking-wider">Security Question</span>
                      <select value={questionId} onChange={(e) => { setQuestionId(e.target.value); setError(''); }} className="bg-white dark:bg-[#1A1517]/40 border border-brand-border rounded-xl p-2.5 text-xs text-brand-plum dark:text-brand-text focus:outline-none focus:border-brand-pink">
                        {SECURITY_RECOVERY_QUESTIONS.map(q => (
                          <option key={q.id} value={q.id}>{q.question}</option>
                        ))}
                        <option value={CUSTOM_QUESTION_SELECT_VALUE}>Write my own question</option>
                      </select>
                    </label>
                    {isCustomRecoveryQuestion && (
                      <label className="flex flex-col gap-1 text-left">
                        <span className="text-[10px] font-bold text-brand-sage uppercase tracking-wider">Custom Question</span>
                        <input type="text" value={customRecoveryQuestion} onChange={(e) => setCustomRecoveryQuestion(e.target.value)} className="bg-white dark:bg-[#1A1517]/40 border border-brand-border rounded-xl p-2.5 text-xs text-brand-plum dark:text-brand-text focus:outline-none focus:border-brand-pink" placeholder="Type your security question" />
                      </label>
                    )}
                    <label className="flex flex-col gap-1 text-left">
                      <span className="text-[10px] font-bold text-brand-sage uppercase tracking-wider">Answer</span>
                      <div className="relative">
                        <input type={showRecoveryAnswer ? 'text' : 'password'} value={recoveryAnswer} onChange={(e) => setRecoveryAnswer(e.target.value)} className="w-full bg-white dark:bg-[#1A1517]/40 border border-brand-border rounded-xl p-2.5 pr-10 text-xs text-brand-plum dark:text-brand-text focus:outline-none focus:border-brand-pink" placeholder="Enter a memorable answer" />
                        <button type="button" onClick={() => setShowRecoveryAnswer(prev => !prev)} className="absolute inset-y-0 right-2 flex items-center text-brand-sage hover:text-brand-pink" title={showRecoveryAnswer ? 'Hide answer' : 'Show answer'}>
                          {showRecoveryAnswer ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      </div>
                    </label>
                    <button onClick={requiresRecoverySetup ? handleSaveMigrationRecovery : handleSaveInitialRecovery} disabled={!canSaveRecoveryQuestion} className="w-full py-3 rounded-2xl bg-brand-pink text-white font-bold text-xs uppercase tracking-widest shadow-md disabled:opacity-40 disabled:cursor-not-allowed">
                      Save Recovery Question
                    </button>
                  </div>
                ) : (
                  <>
                    {!security.isPinCreated && setupStep === 'pin' && (
                      <div className="grid grid-cols-2 gap-2 bg-white/50 dark:bg-black/10 border border-brand-border/50 rounded-2xl p-1">
                        {([4, 8] as PinLength[]).map(length => (
                          <button
                            key={length}
                            type="button"
                            onClick={() => {
                              setSelectedPinLength(length);
                              setPin('');
                              setError('');
                            }}
                            className={`py-2 rounded-xl text-[10px] font-black uppercase tracking-wider transition-all ${
                              selectedPinLength === length
                                ? 'bg-brand-pink text-white shadow-sm'
                                : 'text-brand-sage hover:text-brand-plum'
                            }`}
                          >
                            {length} Digit PIN
                          </button>
                        ))}
                      </div>
                    )}

                    <div className="flex flex-col items-center gap-1.5 py-0.5">
                      <div className="flex gap-3 py-0.5 justify-center min-h-[28px] items-center lg:mt-2 lg:gap-4">
                        {Array.from({ length: visiblePinLength }).map((_, i) => {
                          const hasDigit = i < pin.length;
                          return (
                            <div key={i} className="relative flex items-center justify-center">
                              <div className={`w-3 h-3 rounded-full border-2 transition-all lg:h-3.5 lg:w-3.5 ${hasDigit ? 'bg-brand-pink border-brand-pink shadow-md' : 'border-brand-text-muted/25 bg-transparent lg:border-brand-plum/45 dark:lg:border-[#EADCD1]/55'}`} />
                              {hasDigit && showPin && <span className="absolute text-[8px] font-black text-white leading-none">{pin[i]}</span>}
                            </div>
                          );
                        })}
                      </div>
                      <div className="min-h-[16px] text-center flex flex-col items-center mt-1">
                        <AnimatePresence mode="wait">
                          {error && (
                            <motion.p initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="text-[11px] font-bold text-brand-rose flex items-center gap-1">
                              <AlertCircle className="w-3 h-3 flex-shrink-0" />
                              <span>{error}</span>
                            </motion.p>
                          )}
                          {successMsg && !error && (
                            <motion.p initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="text-[11px] font-bold text-brand-sage flex items-center gap-1">
                              <Check className="w-3.5 h-3.5 text-brand-sage" />
                              <span>{successMsg}</span>
                            </motion.p>
                          )}
                        </AnimatePresence>
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-y-2 gap-x-4 mt-0.5 justify-items-center lg:mx-auto lg:mt-9 lg:w-[300px] lg:gap-x-8 lg:gap-y-8">
                      {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(num => (
                        <motion.button key={num} type="button" whileTap={{ scale: 0.9 }} onClick={() => handleKeyPress(num)} className="w-12.5 h-12.5 sm:w-14 sm:h-14 lg:h-12 lg:w-12 rounded-full bg-white dark:bg-[#1A1517]/40 border border-brand-border dark:border-white/5 flex flex-col items-center justify-center hover:bg-brand-pink/5 hover:border-brand-pink/20 transition-all shadow-sm select-none cursor-pointer lg:bg-transparent lg:border-transparent lg:shadow-none lg:hover:bg-brand-blush-light/45 dark:lg:bg-transparent dark:lg:hover:bg-white/5">
                          <span className="leading-none text-lg sm:text-xl lg:text-xl lg:font-medium font-bold text-[#2C1D21] dark:text-[#ECE6E1]">{num}</span>
                        </motion.button>
                      ))}
                      <motion.button type="button" whileTap={{ scale: 0.9 }} onClick={() => { pin.length > 0 ? handleClear() : setShowPin(!showPin); }} className="w-12.5 h-12.5 sm:w-14 sm:h-14 lg:h-12 lg:w-12 rounded-full flex flex-col items-center justify-center text-brand-text-muted hover:text-brand-plum bg-white hover:bg-brand-blush-light dark:bg-transparent dark:hover:bg-black/20 border border-brand-border dark:border-white/10 shadow-sm transition-all select-none cursor-pointer lg:bg-transparent lg:border-transparent lg:shadow-none lg:hover:bg-brand-blush-light/45 dark:lg:hover:bg-white/5">
                        {pin.length > 0 ? <span className="text-[10px] font-bold uppercase tracking-wider text-brand-pink">Clear</span> : <>{showPin ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}<span className="text-[7px] font-bold tracking-wider uppercase text-brand-text-muted mt-1">Reveal</span></>}
                      </motion.button>
                      <motion.button type="button" whileTap={{ scale: 0.9 }} onClick={() => handleKeyPress('0')} className="w-12.5 h-12.5 sm:w-14 sm:h-14 lg:h-12 lg:w-12 rounded-full bg-white dark:bg-[#1A1517]/40 border border-brand-border dark:border-white/5 flex flex-col items-center justify-center hover:bg-brand-pink/5 hover:border-brand-pink/20 transition-all shadow-sm select-none cursor-pointer lg:bg-transparent lg:border-transparent lg:shadow-none lg:hover:bg-brand-blush-light/45 dark:lg:bg-transparent dark:lg:hover:bg-white/5">
                        <span className="leading-none text-lg sm:text-xl lg:text-xl lg:font-medium font-bold text-[#2C1D21] dark:text-[#ECE6E1]">0</span>
                      </motion.button>
                      <motion.button type="button" whileTap={{ scale: 0.9 }} onClick={handleBackspace} disabled={pin.length === 0} className={`w-12.5 h-12.5 sm:w-14 sm:h-14 lg:h-12 lg:w-12 rounded-full flex flex-col items-center justify-center text-brand-pink hover:text-brand-pink-dark bg-white hover:bg-brand-blush-light dark:bg-transparent dark:hover:bg-black/20 border border-brand-border dark:border-white/10 shadow-sm transition-all select-none cursor-pointer lg:bg-transparent lg:border-transparent lg:shadow-none lg:hover:bg-brand-blush-light/45 dark:lg:hover:bg-white/5 ${pin.length === 0 ? 'opacity-30 cursor-not-allowed' : ''}`}>
                        <Delete className="w-4.5 h-4.5 sm:w-5 sm:h-5" />
                        <span className="text-[7px] font-bold tracking-wider uppercase text-brand-text-muted mt-1">Erase</span>
                      </motion.button>
                    </div>

                    <button onClick={handleSubmit} disabled={!isValidPin(pin, security.isPinCreated ? security.pinLength : selectedPinLength)} className={`w-full py-3.5 lg:py-3 rounded-2xl font-bold text-[11px] sm:text-xs uppercase tracking-widest transition-all mt-1.5 shadow-md cursor-pointer lg:mt-8 ${isValidPin(pin, security.isPinCreated ? security.pinLength : selectedPinLength) ? 'bg-brand-plum text-white hover:bg-brand-pink shadow-brand-plum/10 dark:bg-[#EADCD1] dark:text-[#21191C]' : 'bg-brand-border/60 text-brand-text-muted opacity-40 cursor-not-allowed lg:hidden'}`}>
                      {security.isPinCreated ? 'Unlock Diary' : setupStep === 'confirm' ? 'Confirm PIN' : 'Continue'}
                    </button>

                  </>
                )}

                {error && showRecoveryForm && (
                  <p className="text-[11px] font-bold text-brand-rose flex justify-center items-center gap-1">
                    <AlertCircle className="w-3 h-3" />
                    <span>{error}</span>
                  </p>
                )}
                {successMsg && showRecoveryForm && !error && (
                  <p className="text-[11px] font-bold text-brand-sage flex justify-center items-center gap-1">
                    <Check className="w-3 h-3" />
                    <span>{successMsg}</span>
                  </p>
                )}

                {security.isPinCreated && !requiresRecoverySetup && !isResetting && (
                  <div className="text-center pt-0.5 mt-1.5 lg:mt-7">
                    <button onClick={() => { triggerHaptic(15); setRecoveryMode('choosing'); }} className="text-[10px] sm:text-[11px] font-bold text-brand-text-muted hover:text-brand-pink underline tracking-wide cursor-pointer transition-colors">
                      Forgot security passcode PIN?
                    </button>
                  </div>
                )}

                <AnimatePresence>
                  {recoveryMode && (
                    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-y-0 left-0 right-0 z-40 flex items-center justify-center overflow-y-auto bg-brand-bg/96 px-6 py-8 backdrop-blur-md dark:bg-[#151214]/96 lg:left-1/2 lg:bg-transparent lg:px-10 lg:py-10 lg:backdrop-blur-0 xl:px-16">
                      <motion.div initial={{ scale: 0.96, opacity: 0, y: 14 }} animate={{ scale: 1, opacity: 1, y: 0 }} exit={{ scale: 0.96, opacity: 0, y: 14 }} transition={{ type: 'spring', damping: 24, stiffness: 190 }} className="flex w-full max-w-[390px] flex-col items-center text-center">
                        <div className="flex h-[4.5rem] w-[4.5rem] items-center justify-center rounded-full border border-brand-border/60 bg-white/50 text-brand-pink shadow-sm backdrop-blur-xl dark:border-white/10 dark:bg-white/[0.05] lg:h-20 lg:w-20">
                          <ShieldCheck className="h-7 w-7 stroke-[1.7]" />
                        </div>
                        <h3 className="mt-4 font-serif-diary text-2xl font-bold text-brand-plum dark:text-[#ECE6E1] lg:text-3xl">Reset Passcode PIN</h3>

                        {recoveryMode === 'choosing' && (
                          <div className="mt-3 flex w-full flex-col gap-3">
                            <p className="mx-auto mb-3 max-w-[260px] text-sm leading-relaxed text-brand-text-muted dark:text-[#EADCD1]/68">Choose a verified recovery method to create a new passcode.</p>
                            <button onClick={() => { setRecoveryMode('question'); setRecoveryAnswer(''); }} className="group w-full rounded-2xl border border-brand-border/65 bg-white/45 px-5 py-4 text-left shadow-sm backdrop-blur-xl transition-all hover:border-brand-pink/40 hover:bg-brand-pink/8 dark:border-white/10 dark:bg-white/[0.04] dark:hover:bg-white/[0.07]">
                              <span className="block text-[10px] font-bold uppercase tracking-[0.2em] text-brand-pink">Recovery Method</span>
                              <span className="mt-1 block font-serif-diary text-xl font-bold text-brand-plum dark:text-[#ECE6E1]">Answer Security Question</span>
                            </button>
                            {(security.linkedGoogleUserId || security.linkedGoogleUid) && (
                              <button onClick={handleVerifyGoogleReset} disabled={isResetting} className="group w-full rounded-2xl border border-brand-sage/30 bg-brand-sage/12 px-5 py-4 text-left shadow-sm backdrop-blur-xl transition-all hover:border-brand-sage/55 hover:bg-brand-sage/18 disabled:opacity-50 dark:border-brand-sage/35 dark:bg-brand-sage/10">
                                <span className="block text-[10px] font-bold uppercase tracking-[0.2em] text-brand-sage dark:text-brand-sage-light">Linked Account</span>
                                <span className="mt-1 block font-serif-diary text-xl font-bold text-brand-plum dark:text-[#ECE6E1]">Verify Google Account</span>
                              </button>
                            )}
                          </div>
                        )}

                        {recoveryMode === 'question' && (
                          <div className="mt-6 flex w-full flex-col gap-3">
                            <p className="rounded-2xl border border-brand-border/55 bg-white/35 px-4 py-3 text-sm font-semibold leading-relaxed text-brand-sage backdrop-blur-xl dark:border-white/10 dark:bg-white/[0.04] dark:text-brand-sage-light">{getRecoveryQuestionText(security)}</p>
                            <div className="relative">
                              <input type={showRecoveryAnswer ? 'text' : 'password'} value={recoveryAnswer} onChange={(e) => setRecoveryAnswer(e.target.value)} placeholder="Your answer" className="h-[3.25rem] w-full rounded-2xl border border-brand-border bg-white/55 p-3 pr-11 text-sm text-brand-plum shadow-sm backdrop-blur-xl transition-all placeholder:text-brand-text-muted/55 focus:border-brand-pink focus:outline-none dark:border-white/10 dark:bg-white/[0.04] dark:text-[#ECE6E1]" />
                              <button type="button" onClick={() => setShowRecoveryAnswer(prev => !prev)} className="absolute inset-y-0 right-3 flex items-center text-brand-sage transition-colors hover:text-brand-pink" title={showRecoveryAnswer ? 'Hide answer' : 'Show answer'}>
                                {showRecoveryAnswer ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                              </button>
                            </div>
                            <button onClick={handleVerifySecurityAnswer} disabled={!recoveryAnswer.trim()} className="w-full rounded-2xl bg-brand-plum py-3.5 text-xs font-extrabold uppercase tracking-widest text-white shadow-md shadow-brand-plum/10 transition-all hover:bg-brand-pink disabled:cursor-not-allowed disabled:opacity-40 dark:bg-[#EADCD1] dark:text-[#21191C]">Verify Answer</button>
                          </div>
                        )}

                        {recoveryMode === 'newPin' && (
                          <div className="mt-6 flex w-full flex-col gap-3">
                            <p className="text-sm leading-relaxed text-brand-text-muted dark:text-[#EADCD1]/68">Recovery verified by {recoveryVerifiedBy === 'google' ? 'Google' : 'security question'}. Choose a new 4-digit or 8-digit PIN.</p>
                            <div className="grid grid-cols-2 gap-2 rounded-2xl border border-brand-border/50 bg-white/35 p-1 shadow-sm backdrop-blur-xl dark:border-white/10 dark:bg-white/[0.04]">
                              {([4, 8] as PinLength[]).map(length => (
                                <button
                                  key={length}
                                  type="button"
                                  onClick={() => {
                                    setResetPinLength(length);
                                    setResetNewPin('');
                                    setResetConfirmPin('');
                                  }}
                                  className={`py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wider transition-all ${
                                    resetPinLength === length ? 'bg-brand-pink text-white shadow-sm' : 'text-brand-sage hover:text-brand-plum dark:text-[#EADCD1]/70'
                                  }`}
                                >
                                  {length} Digit
                                </button>
                              ))}
                            </div>
                            <input type="password" inputMode="numeric" maxLength={resetPinLength} value={resetNewPin} onChange={(e) => setResetNewPin(e.target.value.replace(/\D/g, '').slice(0, resetPinLength))} placeholder={`${resetPinLength}-digit new PIN`} className="h-[3.25rem] w-full rounded-2xl border border-brand-border bg-white/55 p-3 text-sm text-brand-plum shadow-sm backdrop-blur-xl transition-all placeholder:text-brand-text-muted/55 focus:border-brand-pink focus:outline-none dark:border-white/10 dark:bg-white/[0.04] dark:text-[#ECE6E1]" />
                            <input type="password" inputMode="numeric" maxLength={resetPinLength} value={resetConfirmPin} onChange={(e) => setResetConfirmPin(e.target.value.replace(/\D/g, '').slice(0, resetPinLength))} placeholder={`Confirm ${resetPinLength}-digit PIN`} className="h-[3.25rem] w-full rounded-2xl border border-brand-border bg-white/55 p-3 text-sm text-brand-plum shadow-sm backdrop-blur-xl transition-all placeholder:text-brand-text-muted/55 focus:border-brand-pink focus:outline-none dark:border-white/10 dark:bg-white/[0.04] dark:text-[#ECE6E1]" />
                            <button onClick={handleResetPin} disabled={!isValidPin(resetNewPin, resetPinLength) || resetNewPin !== resetConfirmPin} className="w-full rounded-2xl bg-brand-plum py-3.5 text-xs font-extrabold uppercase tracking-widest text-white shadow-md shadow-brand-plum/10 transition-all hover:bg-brand-pink disabled:cursor-not-allowed disabled:opacity-40 dark:bg-[#EADCD1] dark:text-[#21191C]">Reset PIN</button>
                          </div>
                        )}

                        {(error || successMsg) && (
                          <p className={`mt-4 text-[11px] font-bold ${error ? 'text-brand-rose' : 'text-brand-sage'}`}>{error || successMsg}</p>
                        )}
                        <button onClick={() => { triggerHaptic(10); setRecoveryMode(null); setRecoveryVerifiedBy(null); setError(''); setSuccessMsg(''); }} className="mt-7 w-full py-2 text-[10px] font-black uppercase tracking-[0.18em] text-brand-text-muted transition-colors hover:text-brand-plum dark:hover:text-[#ECE6E1]">
                          Cancel
                        </button>
                      </motion.div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      <footer className="w-full max-w-sm lg:absolute lg:bottom-8 lg:left-8 lg:right-auto lg:max-w-none lg:items-start lg:text-left xl:left-10 text-center flex flex-col items-center gap-1 z-10 py-1 opacity-65">
        <div className="flex items-center gap-1.5 bg-white/36 dark:bg-white/[0.05] px-3 py-1 rounded-full border border-brand-border/50 dark:border-white/10 text-[8px] sm:text-[9px] font-bold text-brand-plum dark:text-brand-text-muted uppercase tracking-widest backdrop-blur-xl">
          <Lock className="w-2.5 h-2.5 sm:w-3 sm:h-3" />
          <span>Protected Access</span>
        </div>
        <p className="text-[8px] sm:text-[9px] text-brand-text-muted max-w-[260px] leading-normal font-medium lg:hidden">
          Your recovery passphrase protects the diary key before anything reaches Drive.
        </p>
      </footer>
    </div>
  );
}
