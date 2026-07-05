import React, { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertCircle, ArrowLeft, BookOpen, CalendarDays, Check, Delete,
  Cloud, Eye, EyeOff, Fingerprint, HardDrive, Lock, Moon, ShieldCheck, Sparkles, Sun
} from 'lucide-react';
import { AppSettings, BackupFileSummary, GoogleAccountSession, SecurityConfig } from '../types';
import {
  createCustomRecoveryQuestionId,
  createInitialPinWithRecovery,
  bindGoogleRecoveryAccount,
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
import { secureAuthService } from '../platform/security';
import { isNativePlatform } from '../platform';
import { signOutGoogleAuth, startGoogleAuth } from '../utils/googleAuth';
import { diaryRepository } from '../repositories';
import { listDriveBackups, restoreLatestValidDriveBackup } from '../utils/driveBackup';
import { nativeDriveBackupBridge } from '../platform/drive/nativeDriveBackupBridge';
import { populateUserProfileFromGoogle } from '../utils/googleProfile';

interface LockScreenProps {
  initialSecurity: SecurityConfig;
  initialSettings: AppSettings;
  onSecurityChange: (security: SecurityConfig) => void;
  onSettingsChange: (settings: AppSettings) => void;
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

export default function LockScreen({
  initialSecurity,
  initialSettings,
  onSecurityChange,
  onSettingsChange,
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
  const [isBiometricActive, setIsBiometricActive] = useState(false);
  const [requiresRecoverySetup, setRequiresRecoverySetup] = useState(false);
  const [recoveryMode, setRecoveryMode] = useState<RecoveryMode>(null);
  const [isResetting, setIsResetting] = useState(false);
  const [resetPinLength, setResetPinLength] = useState<PinLength>(security.pinLength || 4);
  const [resetNewPin, setResetNewPin] = useState('');
  const [resetConfirmPin, setResetConfirmPin] = useState('');
  const [recoveryVerifiedBy, setRecoveryVerifiedBy] = useState<'question' | 'google' | null>(null);
  const [screenMode, setScreenMode] = useState<'ambient' | 'keypad'>(() => (
    initialSecurity.isPinCreated ? 'ambient' : 'keypad'
  ));
  const [time, setTime] = useState('');
  const [date, setDate] = useState('');
  const [quoteIndex, setQuoteIndex] = useState(0);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => initialSettings.theme || 'light');
  const [showBackupChoice, setShowBackupChoice] = useState(false);
  const [isLinkingBackup, setIsLinkingBackup] = useState(false);
  const [isRestoringBackup, setIsRestoringBackup] = useState(false);
  const [pendingBackupSession, setPendingBackupSession] = useState<GoogleAccountSession | null>(null);
  const [discoveredBackup, setDiscoveredBackup] = useState<BackupFileSummary | null>(null);

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
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  useEffect(() => {
    if (security.isPinCreated && security.isBiometricsEnabled && security.isBiometricsSimulated) {
      const timer = setTimeout(() => {
        void handleBiometricUnlock();
      }, 1000);
      return () => clearTimeout(timer);
    }
  }, [security.isPinCreated, security.isBiometricsEnabled, security.isBiometricsSimulated]);

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

  const completeUnlock = (config: SecurityConfig = security) => {
    if (config.isPinCreated && !hasRecoveryQuestion(config)) {
      setSecurity(config);
      setRequiresRecoverySetup(true);
      setScreenMode('keypad');
      setPin('');
      setError('');
      setSuccessMsg('PIN verified. Set a recovery question to continue.');
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

  const handleBiometricUnlock = async () => {
    triggerHaptic(15);
    setIsBiometricActive(true);
    setError('');

    if (security.isBiometricsSimulated) {
      setSuccessMsg('Verifying fingerprint...');
      setTimeout(() => {
        setIsBiometricActive(false);
        completeUnlock(security);
      }, 900);
      return;
    }

    setSuccessMsg('Initializing secure credential authorization...');
    try {
      const success = await secureAuthService.authenticate(security.passkeyCredentialId);
      if (success) {
        completeUnlock(security);
      } else {
        fail('Authentication did not return validation.');
      }
    } catch (err: any) {
      console.warn('WebAuthn Authentication Error:', err);
      fail(err?.name === 'NotAllowedError' ? 'Credential dialog closed. Use PIN.' : (err?.message || 'Biometric authenticator failed.'));
    } finally {
      setIsBiometricActive(false);
    }
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
        completeUnlock(unlockedSecurity);
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
      const updated = createInitialPinWithRecovery(security, pendingSetupPin, question.id, recoveryAnswer, question.text);
      await diaryRepository.saveSecurityConfig(updated);
      setSecurity(updated);
      onSecurityChange(updated);
      setSuccessMsg('Private diary PIN and recovery question configured.');
      setShowBackupChoice(true);
    } catch (err: any) {
      fail(err?.message || 'Could not save recovery question.');
    }
  };

  const handleInitialGoogleLink = async () => {
    setIsLinkingBackup(true);
    setError('');
    setSuccessMsg('Opening Google account...');
    try {
      const session = await startGoogleAuth('backup');
      const binding = bindGoogleRecoveryAccount(security, session);
      if (!binding.ok) throw new Error(binding.error);
      await diaryRepository.saveSecurityConfig(binding.config);
      setSecurity(binding.config);
      onSecurityChange(binding.config);

      const backupSettings = await diaryRepository.getDriveBackupSettings();
      await diaryRepository.saveDriveBackupSettings({
        ...backupSettings,
        linkedGoogleUserId: session.userId,
        linkedGoogleEmail: session.email,
        linkedGoogleDisplayName: session.displayName,
        linkedAt: Date.now(),
        cloudWriteBlocked: false,
      });
      const currentProfile = await diaryRepository.getUserProfile();
      const updatedProfile = await populateUserProfileFromGoogle(currentProfile, session);
      if (JSON.stringify(updatedProfile) !== JSON.stringify(currentProfile)) {
        await diaryRepository.saveUserProfile(updatedProfile);
      }
      const latest = (await listDriveBackups(session))[0] || null;
      setPendingBackupSession(session);
      setDiscoveredBackup(latest);
      if (!latest) {
        setSuccessMsg('Google backup connected.');
        completeUnlock(binding.config);
      } else {
        setSuccessMsg('A backup was found for this account.');
      }
    } catch (err: any) {
      fail(formatGoogleAuthError(err));
    } finally {
      setIsLinkingBackup(false);
    }
  };

  const handleInitialRestore = async () => {
    if (!pendingBackupSession || !discoveredBackup) return;
    setIsRestoringBackup(true);
    setError('');
    try {
      await restoreLatestValidDriveBackup(pendingBackupSession);
      setSuccessMsg('Your diary was restored securely.');
      completeUnlock(security);
    } catch (err: any) {
      fail(err?.message || 'Could not restore this backup.');
    } finally {
      setIsRestoringBackup(false);
    }
  };

  const handleContinueLocalAfterDiscovery = async () => {
    const settings = await diaryRepository.getDriveBackupSettings();
    await diaryRepository.saveDriveBackupSettings({ ...settings, cloudWriteBlocked: true });
    await nativeDriveBackupBridge.setCloudWriteBlocked({ blocked: true });
    setSuccessMsg('Cloud backup is paused so the existing backup stays safe.');
    completeUnlock(security);
  };

  const handleStayLocal = () => {
    setSuccessMsg('Your diary will stay only on this device.');
    completeUnlock(security);
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
      completeUnlock(updated);
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
      completeUnlock(updated);
    } catch (err: any) {
      fail(err?.message || 'Could not reset PIN.');
    }
  };

  const toggleTheme = async () => {
    const nextTheme: 'light' | 'dark' = theme === 'light' ? 'dark' : 'light';
    const updatedSettings = { ...initialSettings, theme: nextTheme };
    await diaryRepository.saveSettings(updatedSettings);
    onSettingsChange(updatedSettings);
    setTheme(nextTheme);
    triggerHaptic(15);
  };

  const setupTitle = showBackupChoice
    ? discoveredBackup ? 'Restore Your Diary' : 'Protect Your Diary'
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
    ? discoveredBackup
      ? 'A hidden Google Drive backup is available for this account.'
      : 'Link Google for automatic backup and PIN recovery, or stay fully local.'
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
    ? 'bg-gradient-to-tr from-[#131012] via-[#241B1E] to-[#131012]'
    : 'bg-gradient-to-tr from-[#FAF6F0] via-[#FFF5F1] to-[#FAF2EA]';

  const showRecoveryForm = !showBackupChoice && (requiresRecoverySetup || setupStep === 'recovery');
  const isCustomRecoveryQuestion = questionId === CUSTOM_QUESTION_SELECT_VALUE;
  const canSaveRecoveryQuestion = !!recoveryAnswer.trim() && (!isCustomRecoveryQuestion || !!customRecoveryQuestion.trim());
  const visiblePinLength = security.isPinCreated ? (security.pinLength || (pin.length > 4 ? 8 : 4)) : selectedPinLength;

  return (
    <div className={`min-h-screen min-h-[100dvh] w-screen ${activeBgClass} text-brand-text flex flex-col items-center justify-between relative overflow-hidden font-sans select-none px-6 py-6 transition-all duration-700`}>
      <div className="absolute inset-0 z-0 pointer-events-none overflow-hidden">
        <motion.div animate={{ scale: [1, 1.15, 1], x: [0, 30, 0], y: [0, -30, 0] }} transition={{ duration: 15, repeat: Infinity, ease: 'easeInOut' }} className="absolute top-[-20%] left-[-20%] w-[80%] h-[80%] rounded-full opacity-60 bg-brand-pink/15 dark:bg-brand-pink/25 blur-[120px]" />
        <motion.div animate={{ scale: [1, 1.2, 1], x: [0, -40, 0], y: [0, 40, 0] }} transition={{ duration: 20, repeat: Infinity, ease: 'easeInOut', delay: 2 }} className="absolute bottom-[-20%] right-[-10%] w-[90%] h-[90%] rounded-full opacity-50 bg-brand-sage/10 dark:bg-brand-sage/18 blur-[150px]" />
      </div>

      <header className="w-full max-w-sm flex justify-between items-center z-10">
        <div className="flex items-center gap-2 bg-white/70 dark:bg-black/15 backdrop-blur-xl px-3.5 py-1.5 rounded-full border border-brand-border/60 dark:border-white/5 shadow-sm">
          <BookOpen className="w-3.5 h-3.5 text-brand-pink" />
          <span className="text-[9px] font-bold uppercase tracking-[0.2em] text-[#3E2429] dark:text-[#EADCD1]">Dear Diary</span>
        </div>
        <motion.button onClick={toggleTheme} whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }} className="w-9 h-9 rounded-full bg-white/70 dark:bg-black/15 border border-brand-border/60 dark:border-white/5 backdrop-blur-xl flex items-center justify-center text-brand-plum hover:text-brand-pink transition-colors shadow-sm cursor-pointer" title={`Switch to ${theme === 'light' ? 'Dark' : 'Light'} Mode`}>
          {theme === 'light' ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4 text-amber-200" />}
        </motion.button>
      </header>

      <main className="w-full max-w-sm flex-grow flex flex-col justify-center items-center z-10 relative">
        <AnimatePresence mode="wait">
          {screenMode === 'ambient' ? (
            <motion.div key="ambient" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, y: -40, scale: 0.98 }} transition={{ duration: 0.4 }} className="w-full flex flex-col items-center text-center justify-between h-[65vh] sm:h-[70vh] py-4">
              <div className="w-full max-w-[310px] mt-3 select-none px-5 py-5">
                <h2 className="font-serif-diary text-[4.75rem] font-bold text-brand-plum dark:text-[#ECE6E1] leading-none">{time}</h2>
                <div className="mt-3 inline-flex items-center justify-center gap-2 text-[12px] font-bold text-brand-text-muted dark:text-[#EADCD1]/80">
                  <CalendarDays className="w-3.5 h-3.5 text-brand-pink" />
                  <span>{date}</span>
                </div>
              </div>

              <div className="flex flex-col items-center gap-4">
                {security.isBiometricsEnabled ? (
                  <motion.button onClick={handleBiometricUnlock} whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }} className="flex flex-col items-center gap-2.5 group">
                    <div className="w-18 h-18 rounded-full bg-white/80 dark:bg-black/10 border border-brand-border dark:border-white/10 backdrop-blur-md flex items-center justify-center shadow-lg relative">
                      <motion.div animate={{ scale: [1, 1.15, 1], opacity: [0.3, 0.6, 0.3] }} transition={{ duration: 2.5, repeat: Infinity, ease: 'easeInOut' }} className="absolute inset-0 rounded-full border-2 border-brand-pink pointer-events-none" />
                      <Fingerprint className="w-8 h-8 text-brand-pink animate-pulse" />
                    </div>
                    <span className="text-[10px] font-bold tracking-[0.25em] text-brand-pink dark:text-brand-pink-dark uppercase">Touch to Scan</span>
                  </motion.button>
                ) : (
                  <motion.button onClick={() => { triggerHaptic(15); setScreenMode('keypad'); }} whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }} className="flex flex-col items-center gap-2.5 group">
                    <div className="w-16 h-16 rounded-full bg-white/80 dark:bg-black/10 border border-brand-border dark:border-white/10 backdrop-blur-md flex items-center justify-center shadow-md relative">
                      <Lock className="w-6 h-6 text-brand-plum/85 dark:text-brand-text/80 group-hover:text-brand-pink transition-colors stroke-[1.5]" />
                    </div>
                    <span className="text-[10px] font-bold tracking-[0.2em] text-brand-text-muted uppercase">Tap to Unlock</span>
                  </motion.button>
                )}
                {security.isBiometricsEnabled && (
                  <button onClick={() => { triggerHaptic(12); setScreenMode('keypad'); }} className="text-[10px] font-bold text-brand-text-muted hover:text-brand-pink uppercase tracking-widest underline decoration-dotted mt-1">
                    Use PIN Code
                  </button>
                )}
              </div>

              <div className="w-full max-w-xs bg-white dark:bg-[#1A1517]/35 border border-brand-border dark:border-white/10 px-4 py-4 rounded-2xl shadow-md text-center flex flex-col gap-2">
                <p className="text-[9px] font-bold tracking-[0.2em] text-brand-pink uppercase">Sanctuary Note</p>
                <p className="font-serif-diary text-base text-brand-plum dark:text-brand-text leading-snug">{SANCTUARY_QUOTES[quoteIndex]}</p>
                <button onClick={(e) => { e.stopPropagation(); setQuoteIndex(prev => (prev + 1) % SANCTUARY_QUOTES.length); }} className="self-center p-1 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 text-brand-text-muted hover:text-brand-pink transition-all" title="Cycle Inspiration">
                  <Sparkles className="w-3.5 h-3.5 animate-pulse" />
                </button>
              </div>
            </motion.div>
          ) : (
            <motion.div key="keypad" initial={{ opacity: 0, y: 80 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 80 }} transition={{ type: 'spring', damping: 25, stiffness: 180 }} className="w-full">
              <motion.div animate={shakeTrigger ? { x: [-10, 10, -8, 8, -5, 5, 0] } : {}} transition={{ duration: 0.4 }} className="w-full p-4 sm:p-5 flex flex-col gap-4 relative overflow-hidden">
                {security.isPinCreated && !requiresRecoverySetup && (
                  <button onClick={() => { triggerHaptic(10); setScreenMode('ambient'); setPin(''); setError(''); }} className="absolute top-1 left-1 p-2 rounded-full hover:bg-white/40 dark:hover:bg-black/20 text-brand-text-muted hover:text-brand-plum transition-colors" title="Back to Clock">
                    <ArrowLeft className="w-4 h-4 stroke-[2.5]" />
                  </button>
                )}

                <div className="text-center space-y-1 sm:space-y-1.5 flex flex-col items-center mt-2">
                  <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-2xl bg-white dark:bg-[#1A1517]/40 border border-brand-border dark:border-white/5 shadow-md flex items-center justify-center relative backdrop-blur-md">
                    <BookOpen className="w-5.5 h-5.5 sm:w-6.5 sm:h-6.5 text-brand-pink" />
                  </div>
                  <div className="space-y-0.5">
                    <h1 className="font-serif-diary text-xl sm:text-2xl text-[#2C1D21] dark:text-[#ECE6E1] font-bold tracking-tight">Dear Diary</h1>
                    <p className="text-[8px] sm:text-[9px] font-bold tracking-[0.25em] text-brand-pink dark:text-brand-pink-dark uppercase">Your Private Sanctuary</p>
                  </div>
                </div>

                <div className="text-center py-1 border-b border-brand-pink/10 pb-2">
                  <span className="inline-flex p-1.5 bg-brand-pink/10 text-brand-pink rounded-xl mb-1">
                    <ShieldCheck className="w-4 h-4" />
                  </span>
                  <h2 className="text-xs sm:text-sm font-bold text-[#2C1D21] dark:text-[#ECE6E1]">{setupTitle}</h2>
                  <p className="text-[10px] sm:text-[11px] text-brand-text-muted mt-1 leading-relaxed max-w-[260px] mx-auto">{setupCopy}</p>
                </div>

                {showBackupChoice ? (
                  <div className="flex flex-col gap-3">
                    {discoveredBackup ? (
                      <div className="flex flex-col gap-3">
                        <div className="grid grid-cols-2 gap-2 rounded-2xl border border-brand-border bg-white/60 dark:bg-black/10 p-3 text-center">
                          <div>
                            <p className="text-[9px] font-bold uppercase tracking-wider text-brand-sage">Backup date</p>
                            <p className="mt-1 text-[11px] font-bold text-brand-plum dark:text-brand-text">
                              {discoveredBackup.createdTime ? new Date(discoveredBackup.createdTime).toLocaleString() : 'Unknown'}
                            </p>
                          </div>
                          <div>
                            <p className="text-[9px] font-bold uppercase tracking-wider text-brand-sage">Backup size</p>
                            <p className="mt-1 text-[11px] font-bold text-brand-plum dark:text-brand-text">
                              {discoveredBackup.size ? `${(discoveredBackup.size / 1024 / 1024).toFixed(1)} MB` : 'Unknown'}
                            </p>
                          </div>
                        </div>
                        <button onClick={handleInitialRestore} disabled={isRestoringBackup} className="w-full py-3 rounded-2xl bg-brand-pink text-white font-bold text-xs uppercase tracking-widest shadow-md disabled:opacity-50 flex items-center justify-center gap-2">
                          <Cloud className="w-4 h-4" />
                          {isRestoringBackup ? 'Restoring...' : 'Restore Backup'}
                        </button>
                        <button onClick={handleContinueLocalAfterDiscovery} disabled={isRestoringBackup} className="w-full py-3 rounded-2xl border border-brand-border bg-white/60 dark:bg-black/10 text-brand-plum dark:text-brand-text font-bold text-xs uppercase tracking-widest disabled:opacity-50">
                          Continue Local
                        </button>
                      </div>
                    ) : (
                      <div className="flex flex-col gap-3">
                        <button onClick={handleInitialGoogleLink} disabled={isLinkingBackup} className="w-full py-3.5 rounded-2xl bg-brand-pink text-white font-bold text-xs uppercase tracking-widest shadow-md disabled:opacity-50 flex items-center justify-center gap-2">
                          <Cloud className="w-4 h-4" />
                          {isLinkingBackup ? 'Connecting...' : 'Link Google Account'}
                        </button>
                        <button onClick={handleStayLocal} disabled={isLinkingBackup} className="w-full py-3.5 rounded-2xl border border-brand-border bg-white/60 dark:bg-black/10 text-brand-plum dark:text-brand-text font-bold text-xs uppercase tracking-widest disabled:opacity-50 flex items-center justify-center gap-2">
                          <HardDrive className="w-4 h-4" /> Stay Local
                        </button>
                      </div>
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

                    {security.isPinCreated && security.isBiometricsEnabled && (
                      <button onClick={handleBiometricUnlock} className="w-full bg-brand-pink/90 dark:bg-brand-pink text-white py-3 rounded-2xl flex items-center justify-center gap-2.5 transition-all duration-300 font-bold text-xs uppercase tracking-wider shadow-md shadow-brand-pink/15 relative overflow-hidden cursor-pointer">
                        {isBiometricActive && <motion.div initial={{ scale: 0, opacity: 0.5 }} animate={{ scale: 3, opacity: 0 }} transition={{ duration: 1, repeat: Infinity }} className="absolute w-24 h-24 bg-white/20 rounded-full" />}
                        <Fingerprint className="w-4 h-4" />
                        <span>Scan Biometric Authenticator</span>
                      </button>
                    )}

                    <div className="flex flex-col items-center gap-2 py-1">
                      <div className="flex gap-2.5 py-1 justify-center min-h-[32px] items-center">
                        {Array.from({ length: visiblePinLength }).map((_, i) => {
                          const hasDigit = i < pin.length;
                          return (
                            <div key={i} className="relative flex items-center justify-center">
                              <div className={`w-3 h-3 rounded-full border-2 transition-all ${hasDigit ? 'bg-brand-pink border-brand-pink shadow-md' : 'border-brand-text-muted/25 bg-transparent'}`} />
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

                    <div className="grid grid-cols-3 gap-y-2.5 gap-x-5 mt-1 justify-items-center">
                      {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(num => (
                        <motion.button key={num} type="button" whileTap={{ scale: 0.9 }} onClick={() => handleKeyPress(num)} className="w-12.5 h-12.5 sm:w-14 sm:h-14 rounded-full bg-white dark:bg-[#1A1517]/40 border border-brand-border dark:border-white/5 flex flex-col items-center justify-center hover:bg-brand-pink/5 hover:border-brand-pink/20 transition-all shadow-sm select-none cursor-pointer">
                          <span className="leading-none text-lg sm:text-xl font-bold text-[#2C1D21] dark:text-[#ECE6E1]">{num}</span>
                        </motion.button>
                      ))}
                      <motion.button type="button" whileTap={{ scale: 0.9 }} onClick={() => { pin.length > 0 ? handleClear() : setShowPin(!showPin); }} className="w-12.5 h-12.5 sm:w-14 sm:h-14 rounded-full flex flex-col items-center justify-center text-brand-text-muted hover:text-brand-plum bg-white hover:bg-brand-blush-light dark:bg-transparent dark:hover:bg-black/20 border border-brand-border dark:border-white/10 shadow-sm transition-all select-none cursor-pointer">
                        {pin.length > 0 ? <span className="text-[10px] font-bold uppercase tracking-wider text-brand-pink">Clear</span> : <>{showPin ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}<span className="text-[7px] font-bold tracking-wider uppercase text-brand-text-muted mt-1">Reveal</span></>}
                      </motion.button>
                      <motion.button type="button" whileTap={{ scale: 0.9 }} onClick={() => handleKeyPress('0')} className="w-12.5 h-12.5 sm:w-14 sm:h-14 rounded-full bg-white dark:bg-[#1A1517]/40 border border-brand-border dark:border-white/5 flex flex-col items-center justify-center hover:bg-brand-pink/5 hover:border-brand-pink/20 transition-all shadow-sm select-none cursor-pointer">
                        <span className="leading-none text-lg sm:text-xl font-bold text-[#2C1D21] dark:text-[#ECE6E1]">0</span>
                      </motion.button>
                      <motion.button type="button" whileTap={{ scale: 0.9 }} onClick={handleBackspace} disabled={pin.length === 0} className={`w-12.5 h-12.5 sm:w-14 sm:h-14 rounded-full flex flex-col items-center justify-center text-brand-pink hover:text-brand-pink-dark bg-white hover:bg-brand-blush-light dark:bg-transparent dark:hover:bg-black/20 border border-brand-border dark:border-white/10 shadow-sm transition-all select-none cursor-pointer ${pin.length === 0 ? 'opacity-30 cursor-not-allowed' : ''}`}>
                        <Delete className="w-4.5 h-4.5 sm:w-5 sm:h-5" />
                        <span className="text-[7px] font-bold tracking-wider uppercase text-brand-text-muted mt-1">Erase</span>
                      </motion.button>
                    </div>

                    <button onClick={handleSubmit} disabled={!isValidPin(pin, security.isPinCreated ? security.pinLength : selectedPinLength)} className={`w-full py-3.5 rounded-2xl font-bold text-[11px] sm:text-xs uppercase tracking-widest transition-all mt-2 shadow-md cursor-pointer ${isValidPin(pin, security.isPinCreated ? security.pinLength : selectedPinLength) ? 'bg-brand-pink text-white hover:bg-brand-pink-dark shadow-brand-pink/15' : 'bg-brand-border/60 text-brand-text-muted opacity-40 cursor-not-allowed'}`}>
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
                  <div className="text-center pt-1 mt-2">
                    <button onClick={() => { triggerHaptic(15); setRecoveryMode('choosing'); }} className="text-[10px] sm:text-[11px] font-bold text-brand-text-muted hover:text-brand-pink underline tracking-wide cursor-pointer transition-colors">
                      Forgot security passcode PIN?
                    </button>
                  </div>
                )}

                <AnimatePresence>
                  {recoveryMode && (
                    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 z-40 bg-brand-bg/95 dark:bg-brand-bg/95 backdrop-blur-md p-6 flex flex-col justify-center items-center text-center gap-4 overflow-y-auto">
                      <motion.div initial={{ scale: 0.85, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.85, opacity: 0 }} transition={{ type: 'spring', damping: 20 }} className="flex flex-col items-center gap-3.5 w-full">
                        <div className="w-12 h-12 rounded-full bg-brand-pink/10 flex items-center justify-center text-brand-pink">
                          <ShieldCheck className="w-6 h-6 stroke-[2]" />
                        </div>
                        <h3 className="font-serif-diary text-lg font-bold text-brand-plum">Reset Passcode PIN</h3>

                        {recoveryMode === 'choosing' && (
                          <div className="flex flex-col gap-2 w-full min-w-[220px] mt-2">
                            <p className="text-[11px] leading-relaxed text-brand-text-muted max-w-[240px] mx-auto">Choose a verified recovery method.</p>
                            <button onClick={() => { setRecoveryMode('question'); setRecoveryAnswer(''); }} className="w-full bg-brand-pink text-white py-2.5 rounded-xl text-[10px] font-extrabold uppercase tracking-widest hover:bg-brand-pink-dark transition-colors shadow-md shadow-brand-pink/10">
                              Answer Security Question
                            </button>
                            {(security.linkedGoogleUserId || security.linkedGoogleUid) && (
                              <button onClick={handleVerifyGoogleReset} disabled={isResetting} className="w-full bg-brand-sage text-white py-2.5 rounded-xl text-[10px] font-extrabold uppercase tracking-widest hover:bg-brand-sage-dark transition-colors shadow-md shadow-brand-sage/10 disabled:opacity-50">
                                Verify Linked Google Account
                              </button>
                            )}
                          </div>
                        )}

                        {recoveryMode === 'question' && (
                          <div className="flex flex-col gap-3 w-full min-w-[220px]">
                            <p className="text-[11px] text-brand-sage font-bold">{getRecoveryQuestionText(security)}</p>
                            <div className="relative">
                              <input type={showRecoveryAnswer ? 'text' : 'password'} value={recoveryAnswer} onChange={(e) => setRecoveryAnswer(e.target.value)} placeholder="Answer" className="w-full bg-white dark:bg-[#1A1517]/40 border border-brand-border rounded-xl p-2.5 pr-10 text-xs text-brand-plum dark:text-brand-text focus:outline-none focus:border-brand-pink" />
                              <button type="button" onClick={() => setShowRecoveryAnswer(prev => !prev)} className="absolute inset-y-0 right-2 flex items-center text-brand-sage hover:text-brand-pink" title={showRecoveryAnswer ? 'Hide answer' : 'Show answer'}>
                                {showRecoveryAnswer ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                              </button>
                            </div>
                            <button onClick={handleVerifySecurityAnswer} disabled={!recoveryAnswer.trim()} className="w-full bg-brand-pink text-white py-2.5 rounded-xl text-[10px] font-extrabold uppercase tracking-widest hover:bg-brand-pink-dark disabled:opacity-40">Verify Answer</button>
                          </div>
                        )}

                        {recoveryMode === 'newPin' && (
                          <div className="flex flex-col gap-3 w-full min-w-[220px]">
                            <p className="text-[11px] leading-relaxed text-brand-text-muted">Recovery verified by {recoveryVerifiedBy === 'google' ? 'Google' : 'security question'}. Choose a 4-digit or 8-digit PIN.</p>
                            <div className="grid grid-cols-2 gap-2 bg-brand-bg/60 border border-brand-border/50 rounded-xl p-1">
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
                                    resetPinLength === length ? 'bg-brand-pink text-white' : 'text-brand-sage'
                                  }`}
                                >
                                  {length} Digit
                                </button>
                              ))}
                            </div>
                            <input type="password" inputMode="numeric" maxLength={resetPinLength} value={resetNewPin} onChange={(e) => setResetNewPin(e.target.value.replace(/\D/g, '').slice(0, resetPinLength))} placeholder={`${resetPinLength}-digit new PIN`} className="w-full bg-white dark:bg-[#1A1517]/40 border border-brand-border rounded-xl p-2.5 text-xs text-brand-plum dark:text-brand-text focus:outline-none focus:border-brand-pink" />
                            <input type="password" inputMode="numeric" maxLength={resetPinLength} value={resetConfirmPin} onChange={(e) => setResetConfirmPin(e.target.value.replace(/\D/g, '').slice(0, resetPinLength))} placeholder={`Confirm ${resetPinLength}-digit PIN`} className="w-full bg-white dark:bg-[#1A1517]/40 border border-brand-border rounded-xl p-2.5 text-xs text-brand-plum dark:text-brand-text focus:outline-none focus:border-brand-pink" />
                            <button onClick={handleResetPin} disabled={!isValidPin(resetNewPin, resetPinLength) || resetNewPin !== resetConfirmPin} className="w-full bg-brand-pink text-white py-2.5 rounded-xl text-[10px] font-extrabold uppercase tracking-widest hover:bg-brand-pink-dark disabled:opacity-40">Reset PIN</button>
                          </div>
                        )}

                        {(error || successMsg) && (
                          <p className={`text-[11px] font-bold ${error ? 'text-brand-rose' : 'text-brand-sage'}`}>{error || successMsg}</p>
                        )}
                        <button onClick={() => { triggerHaptic(10); setRecoveryMode(null); setRecoveryVerifiedBy(null); setError(''); setSuccessMsg(''); }} className="w-full py-2 text-[10px] font-black uppercase tracking-wider text-brand-text-muted hover:text-brand-plum mt-1">
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

      <footer className="w-full max-w-sm text-center flex flex-col items-center gap-1 z-10 py-1 opacity-70">
        <div className="flex items-center gap-1 bg-brand-rose-light/50 dark:bg-black/10 px-2.5 py-0.5 rounded-full border border-brand-border/80 dark:border-white/5 text-[8px] sm:text-[9px] font-bold text-brand-plum dark:text-brand-text-muted uppercase tracking-widest">
          <Lock className="w-2.5 h-2.5 sm:w-3 sm:h-3" />
          <span>Offline-First Private Access</span>
        </div>
        <p className="text-[8px] sm:text-[9px] text-brand-text-muted max-w-[260px] leading-normal font-medium">
          Your PIN and recovery answer stay on this device. Google is used only if you choose Drive backup or account recovery.
        </p>
      </footer>
    </div>
  );
}
