import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  ArrowLeft, Lock, Bell, Download, Upload, Trash2, 
  Check, ShieldCheck, RefreshCw, FileWarning,
  Plus, Tag, Smile, X, Sun, Moon, Cloud, LogOut, CloudLightning,
  Fingerprint, Palette, ChevronLeft, ChevronRight, Eye, EyeOff
} from 'lucide-react';
import {
  AppSettings,
  BackupFileSummary,
  Diary,
  DriveBackupSettings,
  Entry,
  GoogleAccountSession,
  SecurityConfig,
  Mood,
  Note,
  UserProfile
} from '../types';
import { PREDEFINED_TAGS, PREDEFINED_MOODS, PREDEFINED_COLORS } from '../domain/journalCatalog';
import {
  createCustomRecoveryQuestionId,
  bindGoogleRecoveryAccount,
  getRecoveryQuestionText,
  isValidPin,
  SECURITY_RECOVERY_QUESTIONS,
  updatePinWithCurrentPin,
  withRecoveryQuestion,
} from '../domain/security';
import type { PinLength } from '../domain/security';
import { User, Mail } from 'lucide-react';
import { isNativePlatform } from '../platform';
import { secureAuthService } from '../platform/security';
import { getCachedGoogleDriveSession, signOutGoogleAuth, startGoogleAuth } from '../utils/googleAuth';
import {
  connectGoogleDrive,
  createDriveBackup,
  deleteDriveBackup,
  isDriveAuthorizationError,
  listDriveBackups,
  restoreDriveBackup
} from '../utils/driveBackup';
import { diaryRepository } from '../repositories';
import { createDefaultUserProfile } from '../repositories/defaults';
import { calculateStorageUsage, type StorageDetails } from '../domain/storageUsage';
import { exportEncryptedBackup, importEncryptedBackup } from '../utils/manualBackup';

interface AppSettingsScreenProps {
  diaries: Diary[];
  entries: Entry[];
  notes: Note[];
  initialSettings: AppSettings;
  initialSecurity: SecurityConfig;
  initialProfile: UserProfile;
  onBack: () => void;
  onResetSuccess: () => void | Promise<void>;
  onDataChanged: () => void | Promise<void>;
  onShowToast?: (message: string, type?: 'success' | 'info' | 'warning' | 'error') => void;
}

const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

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
    return 'Google did not grant Drive backup access. Reconnect and approve the Google Drive app data permission.';
  }
  return err?.message || 'Google sign-in failed.';
};

export default function AppSettingsScreen({
  diaries,
  entries,
  notes,
  initialSettings,
  initialSecurity,
  initialProfile,
  onBack,
  onResetSuccess,
  onDataChanged,
  onShowToast
}: AppSettingsScreenProps) {
  const [security, setSecurity] = useState<SecurityConfig>(initialSecurity);
  const [settings, setSettings] = useState<AppSettings>(initialSettings);
  const [activeTab, setActiveTab] = useState<'profile' | 'security' | 'backup' | 'customize'>('profile');

  // Horizontal scroll state for tab bar indicator
  const tabsContainerRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const checkScroll = () => {
    const el = tabsContainerRef.current;
    if (el) {
      const scrollLeft = el.scrollLeft;
      const scrollWidth = el.scrollWidth;
      const clientWidth = el.clientWidth;
      setCanScrollLeft(scrollLeft > 3);
      setCanScrollRight(scrollLeft < scrollWidth - clientWidth - 3);
    }
  };

  useEffect(() => {
    const el = tabsContainerRef.current;
    if (el) {
      checkScroll();
      el.addEventListener('scroll', checkScroll, { passive: true });
      window.addEventListener('resize', checkScroll);
      const ro = new ResizeObserver(() => checkScroll());
      ro.observe(el);

      return () => {
        el.removeEventListener('scroll', checkScroll);
        window.removeEventListener('resize', checkScroll);
        ro.disconnect();
      };
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(checkScroll, 100);
    return () => clearTimeout(timer);
  }, [activeTab]);

  // User Profile States
  const [profile, setProfile] = useState<UserProfile>(initialProfile);
  const [profileName, setProfileName] = useState(profile.name);
  const [profileEmail, setProfileEmail] = useState(profile.email);
  const [profileBio, setProfileBio] = useState(profile.bio);
  const [profileEmoji, setProfileEmoji] = useState(profile.avatarEmoji);
  const [profileColor, setProfileColor] = useState(profile.avatarColor);
  const [profileWritingGoal, setProfileWritingGoal] = useState(profile.writingGoal || 100);
  
  // Custom Tags and Moods
  const [customTags, setCustomTags] = useState<string[]>(settings.customTags || []);
  const [customMoods, setCustomMoods] = useState<Mood[]>(settings.customMoods || []);
  const [newTagInput, setNewTagInput] = useState('');
  const [newMoodNameInput, setNewMoodNameInput] = useState('');
  const [newMoodEmojiInput, setNewMoodEmojiInput] = useState('');

  // PIN change states
  const [showPinForm, setShowPinForm] = useState<boolean>(false);
  const [currentPin, setCurrentPin] = useState<string>('');
  const [newPinLength, setNewPinLength] = useState<PinLength>(security.pinLength || 4);
  const [newPin, setNewPin] = useState<string>('');
  const [confirmPin, setConfirmPin] = useState<string>('');
  const [pinError, setPinError] = useState<string>('');
  const [pinSuccess, setPinSuccess] = useState<boolean>(false);

  // Security question states
  const currentQuestionIsPreset = SECURITY_RECOVERY_QUESTIONS.some(q => q.id === security.recoveryQuestionId);
  const [showRecoveryForm, setShowRecoveryForm] = useState<boolean>(false);
  const [recoveryQuestionId, setRecoveryQuestionId] = useState<string>(
    currentQuestionIsPreset ? (security.recoveryQuestionId || SECURITY_RECOVERY_QUESTIONS[0]?.id || '') : CUSTOM_QUESTION_SELECT_VALUE
  );
  const [customRecoveryQuestion, setCustomRecoveryQuestion] = useState<string>(
    currentQuestionIsPreset ? '' : (security.recoveryQuestionText || '')
  );
  const [securityAnswer, setSecurityAnswer] = useState<string>('');
  const [showSecurityAnswer, setShowSecurityAnswer] = useState<boolean>(false);
  const [recoveryError, setRecoveryError] = useState<string>('');
  const [recoverySuccess, setRecoverySuccess] = useState<boolean>(false);
  const [isRecoveryAccountLoading, setIsRecoveryAccountLoading] = useState(false);
  const [recoveryAccountError, setRecoveryAccountError] = useState('');

  // Reminders preference states
  const [reminderTime, setReminderTime] = useState<string>(settings.reminderTime || '21:00');

  // Encrypted backup states
  const [backupPassword, setBackupPassword] = useState<string>('');
  const [showBackupModal, setShowBackupModal] = useState<boolean>(false);
  const [backupMsg, setBackupMsg] = useState<string>('');
  const [importPassword, setImportPassword] = useState<string>('');
  const [importFile, setImportFile] = useState<File | null>(null);
  const [showImportModal, setShowImportModal] = useState<boolean>(false);
  const [importError, setImportError] = useState<string>('');

  // Reset confirm state
  const [showConfirmReset, setShowConfirmReset] = useState<boolean>(false);

  // Google Drive backup states
  const [backupSession, setBackupSession] = useState<GoogleAccountSession | null>(() => getCachedGoogleDriveSession());
  const [driveBackupSettings, setDriveBackupSettings] = useState<DriveBackupSettings>({});
  const [authError, setAuthError] = useState('');
  const [isAuthLoading, setIsAuthLoading] = useState(false);
  const [isBackingUp, setIsBackingUp] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [isLoadingBackups, setIsLoadingBackups] = useState(false);
  const [backupStep, setBackupStep] = useState<number>(-1);
  const [driveBackups, setDriveBackups] = useState<BackupFileSummary[]>([]);

  // WebAuthn Passkey States
  const [isWebAuthnLoading, setIsWebAuthnLoading] = useState<boolean>(false);
  const [webAuthnError, setWebAuthnError] = useState<string>('');
  const [webAuthnSuccess, setWebAuthnSuccess] = useState<string>('');
  const [showSimulateFallback, setShowSimulateFallback] = useState<boolean>(false);

  const backupAccountEmail = backupSession?.email || driveBackupSettings.linkedGoogleEmail || 'Not connected';

  useEffect(() => {
    void diaryRepository.getDriveBackupSettings().then(setDriveBackupSettings);
  }, []);

  const lastBackupStr = React.useMemo(() => (
    driveBackupSettings.lastBackupAt
      ? new Date(driveBackupSettings.lastBackupAt).toLocaleString()
      : 'Never'
  ), [driveBackupSettings.lastBackupAt]);

  const isBackupStale = React.useMemo(() => {
    const lastBackupAt = driveBackupSettings.lastBackupAt || 0;
    if (!lastBackupAt) return true;
    return entries.some(entry => entry.updatedAt > lastBackupAt) ||
      notes.some(note => note.updatedAt > lastBackupAt);
  }, [driveBackupSettings.lastBackupAt, entries, notes]);

  // Compute storage usage details (text, photos, audio)
  const storageDetails = React.useMemo(() => {
    return calculateStorageUsage(diaries, entries, notes, settings, profile, security);
  }, [diaries, entries, notes, settings, profile, security]);

  const saveConnectedBackupSession = async (session: GoogleAccountSession): Promise<DriveBackupSettings> => {
    const nextBackupSettings: DriveBackupSettings = {
      ...driveBackupSettings,
      linkedGoogleUserId: session.userId,
      linkedGoogleEmail: session.email,
    };
    await diaryRepository.saveDriveBackupSettings(nextBackupSettings);
    setDriveBackupSettings(nextBackupSettings);
    setBackupSession(session);
    return nextBackupSettings;
  };

  const refreshDriveBackups = async (session: GoogleAccountSession | null = backupSession || getCachedGoogleDriveSession()): Promise<void> => {
    if (!session) return;
    setIsLoadingBackups(true);
    setAuthError('');
    try {
      setBackupSession(session);
      setDriveBackups(await listDriveBackups(session));
    } catch (err: any) {
      console.error(err);
      if (isDriveAuthorizationError(err) && err.requiresReconnect) {
        setBackupSession(null);
      }
      setAuthError(formatGoogleAuthError(err));
    } finally {
      setIsLoadingBackups(false);
    }
  };

  const handleGoogleSignIn = async (
    options: { refreshAfterSignIn?: boolean } = {},
  ): Promise<GoogleAccountSession | null> => {
    setAuthError('');
    setIsAuthLoading(true);
    try {
      const session = await connectGoogleDrive();
      await saveConnectedBackupSession(session);
      onShowToast?.(`Google Drive backup connected as ${session.email || 'your Google account'}.`, 'success');
      if (options.refreshAfterSignIn !== false) {
        await refreshDriveBackups(session);
      }
      return session;
    } catch (err: any) {
      console.error(err);
      setAuthError(formatGoogleAuthError(err));
      return null;
    } finally {
      setIsAuthLoading(false);
    }
  };

  const ensureDriveSession = async (): Promise<GoogleAccountSession | null> => {
    const session = backupSession || getCachedGoogleDriveSession();
    if (session?.accessToken) {
      setBackupSession(session);
      return session;
    }
    return handleGoogleSignIn({ refreshAfterSignIn: false });
  };

  const runDriveOperation = async <T,>(
    operation: (session: GoogleAccountSession) => Promise<T>,
  ): Promise<{ result: T; session: GoogleAccountSession }> => {
    const session = await ensureDriveSession();
    if (!session) {
      throw new Error('Connect Google Drive before continuing.');
    }

    try {
      return { result: await operation(session), session };
    } catch (err) {
      if (isDriveAuthorizationError(err) && err.requiresReconnect) {
        setBackupSession(null);
        onShowToast?.('Google Drive needs fresh authorization. Please approve access again.', 'info');
        const freshSession = await handleGoogleSignIn({ refreshAfterSignIn: false });
        if (!freshSession) {
          throw err;
        }
        return { result: await operation(freshSession), session: freshSession };
      }
      throw err;
    }
  };

  const handleCreateDriveBackup = async () => {
    setIsBackingUp(true);
    setBackupStep(0);
    try {
      setBackupStep(1);
      const { result, session } = await runDriveOperation(createDriveBackup);
      setBackupStep(2);
      setDriveBackupSettings(result.settings);
      await refreshDriveBackups(session);
      setBackupStep(3);
      onShowToast?.('Google Drive backup created successfully.', 'success');
    } catch (err: any) {
      console.error(err);
      setAuthError(formatGoogleAuthError(err));
      onShowToast?.(err?.message || 'Could not create Google Drive backup.', 'error');
    } finally {
      setIsBackingUp(false);
      setBackupStep(-1);
    }
  };

  const handleRestoreDriveBackup = async (fileId: string) => {
    const confirmed = window.confirm('Restore this Drive backup? Your current local journal will be replaced after a safety snapshot is created.');
    if (!confirmed) return;

    setIsRestoring(true);
    setBackupStep(0);
    try {
      setBackupStep(1);
      const { result: nextSettings } = await runDriveOperation(session => restoreDriveBackup(session, fileId));
      setBackupStep(2);
      setDriveBackupSettings(nextSettings);
      onShowToast?.('Backup restored. The application will refresh.', 'success');
      setTimeout(() => window.location.reload(), 1200);
    } catch (err: any) {
      console.error(err);
      setAuthError(formatGoogleAuthError(err));
      onShowToast?.(err?.message || 'Could not restore Google Drive backup.', 'error');
    } finally {
      setIsRestoring(false);
      setBackupStep(-1);
    }
  };

  const handleDeleteDriveBackup = async (fileId: string) => {
    const confirmed = window.confirm('Delete this backup from Google Drive app data?');
    if (!confirmed) return;

    try {
      const { session } = await runDriveOperation(async activeSession => {
        await deleteDriveBackup(activeSession, fileId);
        return true;
      });
      await refreshDriveBackups(session);
      onShowToast?.('Drive backup deleted.', 'info');
    } catch (err: any) {
      console.error(err);
      setAuthError(formatGoogleAuthError(err));
    }
  };

  const handleSignOutClick = async () => {
    try {
      await signOutGoogleAuth();
      setBackupSession(null);
      setDriveBackups([]);
      onShowToast?.('Signed out of Google Drive backup.', 'info');
    } catch (err) {
      console.error(err);
    }
  };

  const persistSettings = async (updatedSettings: AppSettings): Promise<void> => {
    await diaryRepository.saveSettings(updatedSettings);
    setSettings(updatedSettings);
    await onDataChanged();
  };

  const persistSecurity = async (updatedSecurity: SecurityConfig): Promise<void> => {
    await diaryRepository.saveSecurityConfig(updatedSecurity);
    setSecurity(updatedSecurity);
    await onDataChanged();
  };

  const handleThemeChange = async (newTheme: 'light' | 'dark') => {
    const updated: AppSettings = {
      ...settings,
      theme: newTheme
    };
    await persistSettings(updated);
    if (newTheme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  };

  const handleAddCustomTag = async () => {
    const tag = newTagInput.trim().toLowerCase();
    if (tag && !PREDEFINED_TAGS.includes(tag) && !customTags.includes(tag)) {
      const nextTags = [...customTags, tag];
      setCustomTags(nextTags);
      await persistSettings({ ...settings, customTags: nextTags, customMoods });
    }
    setNewTagInput('');
  };

  const handleRemoveCustomTag = async (tag: string) => {
    const nextTags = customTags.filter(t => t !== tag);
    setCustomTags(nextTags);
    await persistSettings({ ...settings, customTags: nextTags, customMoods });
  };

  const handleAddCustomMood = async () => {
    const name = newMoodNameInput.trim();
    const emoji = newMoodEmojiInput.trim();
    const existingNames = PREDEFINED_MOODS.map(m => m.name.toLowerCase());
    if (name && emoji && !existingNames.includes(name.toLowerCase()) && !customMoods.some(m => m.name.toLowerCase() === name.toLowerCase())) {
      const nextMoods = [...customMoods, { name, emoji }];
      setCustomMoods(nextMoods);
      await persistSettings({ ...settings, customTags, customMoods: nextMoods });
    }
    setNewMoodNameInput('');
    setNewMoodEmojiInput('');
  };

  const handleRemoveCustomMood = async (moodName: string) => {
    const nextMoods = customMoods.filter(m => m.name !== moodName);
    setCustomMoods(nextMoods);
    await persistSettings({ ...settings, customTags, customMoods: nextMoods });
  };

  const handlePinChangeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPinError('');
    setPinSuccess(false);

    if (!isValidPin(currentPin, security.pinLength)) {
      setPinError(`Enter your current ${security.pinLength || '4 or 8'}-digit PIN.`);
      return;
    }

    if (!isValidPin(newPin, newPinLength)) {
      setPinError(`New PIN must be exactly ${newPinLength} digits.`);
      return;
    }

    if (newPin !== confirmPin) {
      setPinError('PINs do not match. Please try again.');
      return;
    }

    try {
      const updated = updatePinWithCurrentPin(security, currentPin, newPin);
      await persistSecurity(updated);
      setPinSuccess(true);
      setCurrentPin('');
      setNewPin('');
      setConfirmPin('');
      setTimeout(() => {
        setShowPinForm(false);
        setPinSuccess(false);
      }, 1500);
    } catch (err: any) {
      setPinError(err?.message || 'Could not update PIN.');
    }
  };

  const handleToggleRecoveryForm = () => {
    const nextVisible = !showRecoveryForm;
    setShowRecoveryForm(nextVisible);
    setRecoveryError('');
    setRecoverySuccess(false);
    setSecurityAnswer('');
    setShowSecurityAnswer(false);

    if (nextVisible) {
      const isPreset = SECURITY_RECOVERY_QUESTIONS.some(q => q.id === security.recoveryQuestionId);
      setRecoveryQuestionId(isPreset ? (security.recoveryQuestionId || SECURITY_RECOVERY_QUESTIONS[0]?.id || '') : CUSTOM_QUESTION_SELECT_VALUE);
      setCustomRecoveryQuestion(isPreset ? '' : getRecoveryQuestionText(security));
    }
  };

  const handleRecoveryQuestionSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setRecoveryError('');
    setRecoverySuccess(false);

    if (!security.isPinCreated) {
      setRecoveryError('Create an App Security PIN before setting a recovery question.');
      return;
    }

    if (recoveryQuestionId === CUSTOM_QUESTION_SELECT_VALUE && !customRecoveryQuestion.trim()) {
      setRecoveryError('Enter your custom security question.');
      return;
    }

    if (!securityAnswer.trim()) {
      setRecoveryError('Enter a security answer.');
      return;
    }

    try {
      const questionId = recoveryQuestionId === CUSTOM_QUESTION_SELECT_VALUE
        ? createCustomRecoveryQuestionId()
        : recoveryQuestionId;
      const questionText = recoveryQuestionId === CUSTOM_QUESTION_SELECT_VALUE
        ? customRecoveryQuestion.trim()
        : undefined;
      const updated = withRecoveryQuestion(security, questionId, securityAnswer, questionText);
      await persistSecurity(updated);
      setSecurityAnswer('');
      setRecoverySuccess(true);
      onShowToast?.('Security question updated successfully.', 'success');
    } catch (err: any) {
      setRecoveryError(err?.message || 'Could not update security question.');
    }
  };

  const handleToggleBiometrics = async (checked: boolean) => {
    if (!security.isPinCreated) {
      setWebAuthnError('Please configure an App Security PIN code first.');
      onShowToast?.('Please configure an App Security PIN code first.', 'warning');
      return;
    }

    setWebAuthnError('');
    setWebAuthnSuccess('');
    setShowSimulateFallback(false);

    if (!checked) {
      const newConfig = {
        ...security,
        isBiometricsEnabled: false,
        passkeyCredentialId: undefined,
        isBiometricsSimulated: undefined
      };
      await persistSecurity(newConfig);
      onShowToast?.('Biometric security disabled.', 'info');
      return;
    }

    setIsWebAuthnLoading(true);
    try {
      const result = await secureAuthService.enroll(backupSession?.email || profile.email || 'dear.diary.user');
      if (result) {
        const newConfig = {
          ...security,
          isBiometricsEnabled: true,
          passkeyCredentialId: result.credentialId,
          isBiometricsSimulated: !!result.simulated
        };
        await persistSecurity(newConfig);
        const successText = isNativePlatform()
          ? 'Native biometric unlock enabled successfully!'
          : 'Secure WebAuthn Passkey enrolled and enabled successfully!';
        setWebAuthnSuccess(successText);
        onShowToast?.(successText, 'success');
      } else if (isNativePlatform()) {
        setWebAuthnError('No enrolled fingerprint or strong biometric credential is available. Add one in Android Settings, then try again.');
        onShowToast?.('Add a fingerprint in Android Settings, then enable biometric unlock again.', 'warning');
      } else {
        setWebAuthnError('This browser could not enroll a passkey. Please continue using your PIN.');
      }
    } catch (err: any) {
      console.warn('WebAuthn registration error:', err);
      if (
        err?.name === 'NotAllowedError' || 
        err?.name === 'SecurityError' || 
        err?.message?.includes('secure context') ||
        err?.message?.includes('not supported')
      ) {
        setWebAuthnError(`Device/Browser restriction: standard Passkeys require HTTPS and direct tab access (cannot be created inside framed environments). You can enable a Simulated Passkey for previewing.`);
        setShowSimulateFallback(true);
      } else {
        setWebAuthnError(err?.message || 'Failed to register Passkey with your device.');
      }
    } finally {
      setIsWebAuthnLoading(false);
    }
  };

  const handleEnableSimulatedBiometrics = async () => {
    const newConfig = {
      ...security,
      isBiometricsEnabled: true,
      passkeyCredentialId: 'simulated-passkey-id-12345',
      isBiometricsSimulated: true
    };
    await persistSecurity(newConfig);
    setWebAuthnSuccess('Simulated device biometric unlock enabled successfully!');
    setShowSimulateFallback(false);
    setWebAuthnError('');
    onShowToast?.('Simulated biometric unlock enabled.', 'success');
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    const defaultProfile = createDefaultUserProfile(driveBackupSettings.linkedGoogleEmail);
    const updatedProfile: UserProfile = {
      ...profile,
      name: profileName.trim() || defaultProfile.name,
      email: profileEmail.trim() || defaultProfile.email,
      bio: profileBio.trim(),
      avatarEmoji: profileEmoji,
      avatarColor: profileColor,
      writingGoal: profileWritingGoal
    };
    await diaryRepository.saveUserProfile(updatedProfile);
    setProfile(updatedProfile);
    await onDataChanged();
    if (onShowToast) {
      onShowToast('User Profile saved successfully!', 'success');
    }
  };

  const handleReminderToggle = async (enabled: boolean) => {
    const updated: AppSettings = {
      ...settings,
      remindersEnabled: enabled
    };
    await persistSettings(updated);
  };

  const handleLinkRecoveryAccount = async () => {
    if (!security.isPinCreated) {
      setRecoveryAccountError('Create an App Security PIN before linking a recovery account.');
      return;
    }

    setIsRecoveryAccountLoading(true);
    setRecoveryAccountError('');
    try {
      const session = await startGoogleAuth('pin-reset');
      const result = bindGoogleRecoveryAccount(security, session);
      if (!result.ok) {
        setRecoveryAccountError(result.error || 'This Google account cannot be linked.');
        return;
      }
      await persistSecurity(result.config);
      onShowToast?.(`PIN recovery linked to ${session.email || 'your Google account'}.`, 'success');
    } catch (err: any) {
      setRecoveryAccountError(formatGoogleAuthError(err));
    } finally {
      setIsRecoveryAccountLoading(false);
    }
  };

  const handleReminderTimeChange = async (timeStr: string) => {
    setReminderTime(timeStr);
    const updated: AppSettings = {
      ...settings,
      reminderTime: timeStr
    };
    await persistSettings(updated);
  };

  const handleExportBackup = async () => {
    if (!backupPassword) {
      setBackupMsg('Please provide a password for encryption.');
      return;
    }

    try {
      const encryptedString = await exportEncryptedBackup(backupPassword);
      
      // Generate a downloadable file block
      const blob = new Blob([encryptedString], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `deardiary_backup_${new Date().toISOString().split('T')[0]}.txt`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      setBackupMsg('Backup generated and downloaded successfully!');
      setBackupPassword('');
      setTimeout(() => {
        setShowBackupModal(false);
        setBackupMsg('');
      }, 2000);
    } catch (err) {
      setBackupMsg('Failed to generate backup.');
    }
  };

  const handleImportFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setImportFile(e.target.files[0]);
    }
  };

  const handleImportBackup = () => {
    if (!importFile) {
      setImportError('Please select a backup file to import.');
      return;
    }
    if (!importPassword) {
      setImportError('Please enter the password used to encrypt this backup.');
      return;
    }

    const reader = new FileReader();
    reader.onload = async (e) => {
      const fileContent = e.target?.result as string;
      if (fileContent) {
        const success = await importEncryptedBackup(fileContent, importPassword);
        if (success) {
          if (onShowToast) {
            onShowToast('Backup restored successfully! The application will refresh.', 'success');
          } else {
            alert('Backup restored successfully! The application will refresh.');
          }
          window.location.reload();
        } else {
          setImportError('Decryption failed. Please check your password or file.');
        }
      }
    };
    reader.readAsText(importFile);
  };

  const handleResetDatabase = async () => {
    await diaryRepository.resetContent();
    await onResetSuccess();
    setShowConfirmReset(false);
    if (onShowToast) {
      onShowToast('All diary entries, notes, and photos have been reset.', 'success');
    } else {
      alert('All diary entries, notes, and photos have been reset. Default "My Diary" created.');
    }
  };

  return (
    <div className="flex flex-col gap-6 font-sans">
      {/* Header */}
      <header className="flex justify-between items-center bg-brand-bg/95 backdrop-blur-md sticky top-0 py-3 z-30 border-b border-brand-rose-light/40">
        <div className="flex items-center gap-2">
          <button 
            onClick={onBack}
            className="p-2 text-brand-plum hover:bg-brand-blush-light rounded-full transition-all"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <h1 className="font-serif-diary text-xl font-bold text-brand-plum">Diary Protection & Settings</h1>
        </div>
      </header>

      {/* Tab Navigation Wrapper */}
      <div className="relative w-full">
        {/* Left scroll fade & chevron indicator */}
        <AnimatePresence>
          {canScrollLeft && (
            <motion.div 
              initial={{ opacity: 0, x: -4 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -4 }}
              transition={{ duration: 0.2 }}
              className="absolute left-0 top-0 bottom-0 w-12 bg-gradient-to-r from-brand-bg via-brand-bg/85 to-transparent pointer-events-none z-20 flex items-center pl-1"
            >
              <button
                type="button"
                onClick={() => tabsContainerRef.current?.scrollBy({ left: -120, behavior: 'smooth' })}
                className="w-7 h-7 rounded-full bg-brand-card-bg/95 dark:bg-brand-card-bg/95 shadow-[0_2px_8px_rgba(0,0,0,0.08)] dark:shadow-[0_4px_12px_rgba(0,0,0,0.3)] border border-brand-border/80 dark:border-white/10 flex items-center justify-center text-brand-sage hover:text-brand-plum dark:hover:text-brand-text active:scale-90 transition-all cursor-pointer pointer-events-auto"
                aria-label="Scroll left"
              >
                <ChevronLeft className="w-4 h-4 stroke-[2.5px]" />
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Right scroll fade & chevron indicator */}
        <AnimatePresence>
          {canScrollRight && (
            <motion.div 
              initial={{ opacity: 0, x: 4 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 4 }}
              transition={{ duration: 0.2 }}
              className="absolute right-0 top-0 bottom-0 w-12 bg-gradient-to-l from-brand-bg via-brand-bg/85 to-transparent pointer-events-none z-20 flex items-center justify-end pr-1"
            >
              <button
                type="button"
                onClick={() => tabsContainerRef.current?.scrollBy({ left: 120, behavior: 'smooth' })}
                className="w-7 h-7 rounded-full bg-brand-card-bg/95 dark:bg-brand-card-bg/95 shadow-[0_2px_8px_rgba(0,0,0,0.08)] dark:shadow-[0_4px_12px_rgba(0,0,0,0.3)] border border-brand-border/80 dark:border-white/10 flex items-center justify-center text-brand-sage hover:text-brand-plum dark:hover:text-brand-text active:scale-90 transition-all cursor-pointer pointer-events-auto"
                aria-label="Scroll right"
              >
                <ChevronRight className="w-4 h-4 stroke-[2.5px]" />
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Tab Navigation */}
        <div 
          ref={tabsContainerRef}
          className="flex bg-brand-bg/50 dark:bg-brand-card-bg/40 p-1.5 rounded-2xl border border-brand-border/60 dark:border-white/5 shadow-inner gap-1 overflow-x-auto no-scrollbar scroll-smooth relative"
        >
          {[
            { 
              id: 'profile' as const, 
              label: 'Profile', 
              icon: User, 
              activeBg: 'bg-brand-pink', 
              activeShadow: 'shadow-[0_4px_12px_rgba(181,66,97,0.25)]', 
              colorClass: 'text-brand-pink' 
            },
            { 
              id: 'security' as const, 
              label: 'Security', 
              icon: ShieldCheck, 
              activeBg: 'bg-brand-sage', 
              activeShadow: 'shadow-[0_4px_12px_rgba(69,98,80,0.25)]', 
              colorClass: 'text-brand-sage' 
            },
            { 
              id: 'backup' as const,
              label: 'Backup',
              icon: CloudLightning, 
              activeBg: 'bg-brand-rose', 
              activeShadow: 'shadow-[0_4px_12px_rgba(195,96,76,0.25)]', 
              colorClass: 'text-brand-rose' 
            },
            { 
              id: 'customize' as const, 
              label: 'Customize', 
              icon: Palette, 
              activeBg: 'bg-brand-pink-dark', 
              activeShadow: 'shadow-[0_4px_12px_rgba(117,31,53,0.25)]', 
              colorClass: 'text-brand-pink-dark dark:text-brand-pink' 
            },
          ].map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className="relative flex-1 min-w-[100px] py-2 px-2.5 rounded-xl text-xs font-bold transition-all flex items-center justify-center cursor-pointer select-none group active:scale-[0.98]"
              >
                {isActive && (
                  <motion.div
                    layoutId="settingsActiveTab"
                    className={`absolute inset-0 ${tab.activeBg} rounded-xl ${tab.activeShadow}`}
                    transition={{ type: "spring", stiffness: 380, damping: 30 }}
                  />
                )}
                <span className={`relative z-10 flex items-center justify-center gap-1.5 transition-all duration-300 ${
                  isActive 
                    ? 'text-white scale-[1.03] tracking-wide' 
                    : 'text-brand-text-muted dark:text-brand-text-muted/80 group-hover:text-brand-plum dark:group-hover:text-brand-text'
                }`}>
                  <Icon className={`w-3.5 h-3.5 shrink-0 transition-all duration-300 ${
                    isActive 
                      ? 'scale-110 text-white' 
                      : `${tab.colorClass} opacity-75 group-hover:opacity-100 group-hover:scale-110`
                  }`} />
                  <span>{tab.label}</span>
                </span>
                
                {/* Subtle hover background capsule for interactive tactile feel */}
                {!isActive && (
                  <div className="absolute inset-0 rounded-xl bg-brand-blush-light/0 dark:bg-white/0 group-hover:bg-brand-blush-light/40 dark:group-hover:bg-white/5 transition-colors duration-200 -z-0 pointer-events-none" />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Security Config settings */}
      <div className="flex flex-col gap-5">
        <AnimatePresence mode="wait">
          {activeTab === 'profile' && (
            <motion.div
              key="profile"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.15 }}
              className="flex flex-col gap-5"
            >
              {/* User Profile Customizer Card */}
              <div className="bg-brand-card-bg p-6 rounded-3xl journal-shadow border border-brand-border flex flex-col gap-5">
                <div className="flex items-center gap-3">
                  <span className="p-2.5 bg-brand-blush-light dark:bg-brand-blush-light/10 text-brand-pink rounded-2xl">
                    <User className="w-4 h-4" />
                  </span>
                  <div>
                    <h3 className="text-sm font-bold text-brand-plum dark:text-brand-text">My User Profile</h3>
                    <p className="text-[10px] text-brand-sage mt-0.5">Personalize your welcoming details and daily targets</p>
                  </div>
                </div>

                <form onSubmit={handleSaveProfile} className="flex flex-col gap-4">
                  
                  {/* Avatar Preview & Selection */}
                  <div className="flex flex-col items-center gap-3 bg-brand-bg/50 dark:bg-brand-bg/25 p-4 rounded-2xl border border-brand-border/40">
                    <div 
                      className="w-20 h-20 rounded-full flex items-center justify-center text-4xl shadow-md border-2 border-brand-border"
                      style={{ backgroundColor: profileColor }}
                    >
                      <span>{profileEmoji}</span>
                    </div>
                    
                    {/* Emojis list */}
                    <div className="flex flex-col gap-2 w-full mt-2">
                      <span className="text-[10px] text-brand-sage font-bold uppercase tracking-wider text-center">Choose Emoji</span>
                      <div className="flex justify-center gap-1.5 flex-wrap">
                        {['ðŸŒ¸', 'â˜•', 'ðŸ¦Š', 'ðŸ¥‘', 'ðŸŒ¿', 'ðŸŽ’', 'ðŸ›¹', 'ðŸŽ¨', 'âœ¨', 'ðŸ§˜', 'ðŸ¦„', 'ðŸ³', 'ðŸ¾'].map(emo => (
                          <button
                            key={emo}
                            type="button"
                            onClick={() => setProfileEmoji(emo)}
                            className={`text-xl p-1.5 rounded-xl hover:scale-110 active:scale-95 transition-transform ${profileEmoji === emo ? 'bg-brand-pink/15 scale-105' : ''}`}
                          >
                            {emo}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Colors list */}
                    <div className="flex flex-col gap-2 w-full mt-1">
                      <span className="text-[10px] text-brand-sage font-bold uppercase tracking-wider text-center">Choose Cover Color</span>
                      <div className="flex justify-center gap-2 flex-wrap">
                        {PREDEFINED_COLORS.map(col => (
                          <button
                            key={col.hex}
                            type="button"
                            onClick={() => setProfileColor(col.hex)}
                            className={`w-6 h-6 rounded-full border border-black/10 hover:scale-110 active:scale-95 transition-all ${profileColor === col.hex ? 'ring-2 ring-brand-pink ring-offset-2' : ''}`}
                            style={{ backgroundColor: col.hex }}
                            title={col.name}
                          />
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Fields */}
                  <div className="flex flex-col gap-3">
                    <div>
                      <label className="text-[10px] text-brand-sage font-bold uppercase tracking-wider block mb-1">Your Nickname</label>
                      <div className="relative flex items-center">
                        <User className="w-4 h-4 text-brand-sage absolute left-3.5 pointer-events-none" />
                        <input
                          type="text"
                          value={profileName}
                          onChange={(e) => setProfileName(e.target.value)}
                          placeholder={backupSession?.displayName || "Your nickname"}
                          className="w-full bg-brand-bg border border-brand-border py-2.5 pl-10 pr-4 rounded-xl text-xs text-brand-plum dark:text-brand-text focus:outline-none focus:border-brand-pink"
                          required
                        />
                      </div>
                    </div>

                    <div>
                      <label className="text-[10px] text-brand-sage font-bold uppercase tracking-wider block mb-1">Email Address</label>
                      <div className="relative flex items-center">
                        <Mail className="w-4 h-4 text-brand-sage absolute left-3.5 pointer-events-none" />
                        <input
                          type="email"
                          value={profileEmail}
                          onChange={(e) => setProfileEmail(e.target.value)}
                          placeholder={backupSession?.email || "Email address"}
                          className="w-full bg-brand-bg border border-brand-border py-2.5 pl-10 pr-4 rounded-xl text-xs text-brand-plum dark:text-brand-text focus:outline-none focus:border-brand-pink"
                          required
                        />
                      </div>
                    </div>

                    <div>
                      <label className="text-[10px] text-brand-sage font-bold uppercase tracking-wider block mb-1">Daily Mantra / Bio</label>
                      <textarea
                        value={profileBio}
                        onChange={(e) => setProfileBio(e.target.value)}
                        placeholder="Savoring the simple, quiet moments of life."
                        rows={2}
                        className="w-full bg-brand-bg border border-brand-border p-3 rounded-xl text-xs text-brand-plum dark:text-brand-text focus:outline-none focus:border-brand-pink resize-none"
                      />
                    </div>

                    <div>
                      <div className="flex justify-between items-center mb-1">
                        <label className="text-[10px] text-brand-sage font-bold uppercase tracking-wider">Daily Writing Target</label>
                        <span className="font-mono text-xs text-brand-pink font-bold">{profileWritingGoal} words</span>
                      </div>
                      <input
                        type="range"
                        min="50"
                        max="1000"
                        step="50"
                        value={profileWritingGoal}
                        onChange={(e) => setProfileWritingGoal(Number(e.target.value))}
                        className="w-full accent-brand-pink h-1.5 bg-brand-bg rounded-lg appearance-none cursor-pointer border border-brand-border"
                      />
                      <div className="flex justify-between text-[8px] text-brand-sage font-bold mt-1">
                        <span>50 words</span>
                        <span>500 words</span>
                        <span>1000 words</span>
                      </div>
                    </div>
                  </div>

                  <button
                    type="submit"
                    className="w-full mt-2 bg-brand-pink hover:bg-brand-pink-dark text-white text-xs font-bold py-3.5 rounded-xl transition-all shadow-md shadow-brand-pink/10 hover:shadow-lg active:scale-[0.98]"
                  >
                    Save Profile Details
                  </button>
                </form>

                {/* Member badge info */}
                <div className="flex justify-between items-center text-[10px] text-brand-sage font-semibold border-t border-brand-border/40 pt-3">
                  <span>Journaling Journey Started</span>
                  <span className="text-brand-plum dark:text-brand-text font-bold uppercase tracking-wider">
                    {profile.joinedDate || 'June 2026'}
                  </span>
                </div>
              </div>
            </motion.div>
          )}

          {activeTab === 'security' && (
            <motion.div
              key="security"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.15 }}
              className="flex flex-col gap-5"
            >
              {/* PIN Change card */}
              <div className="bg-brand-card-bg p-5 rounded-3xl journal-shadow border border-brand-border flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="p-2.5 bg-brand-blush-light dark:bg-brand-blush-light/10 text-brand-pink rounded-2xl">
                      <Lock className="w-4 h-4" />
                    </span>
                    <div>
                      <h3 className="text-sm font-bold text-brand-plum">Update App Security PIN</h3>
                      <p className="text-[10px] text-brand-sage mt-0.5">Change your 4-digit or 8-digit passcode</p>
                    </div>
                  </div>
                  <button
                    onClick={() => setShowPinForm(!showPinForm)}
                    className="px-4 py-2 bg-brand-bg hover:bg-brand-rose-light text-xs font-bold text-brand-sage-dark rounded-full border border-brand-border transition-colors"
                  >
                    {showPinForm ? 'Close' : 'Modify'}
                  </button>
                </div>

                {showPinForm && (
                  <form onSubmit={handlePinChangeSubmit} className="mt-3 pt-3 border-t border-brand-border flex flex-col gap-3">
                    <div className="flex flex-col gap-1">
                      <span className="text-[10px] font-bold text-brand-sage uppercase tracking-wider">New PIN Length</span>
                      <div className="grid grid-cols-2 gap-2 bg-brand-bg/70 border border-brand-border rounded-xl p-1">
                        {([4, 8] as PinLength[]).map(length => (
                          <button
                            key={length}
                            type="button"
                            onClick={() => {
                              setNewPinLength(length);
                              setNewPin('');
                              setConfirmPin('');
                              setPinError('');
                            }}
                            className={`py-2 rounded-lg text-[10px] font-black uppercase tracking-wider transition-all ${
                              newPinLength === length
                                ? 'bg-brand-sage text-white shadow-sm'
                                : 'text-brand-sage hover:text-brand-plum'
                            }`}
                          >
                            {length} Digit PIN
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div className="flex flex-col gap-1">
                        <span className="text-[10px] font-bold text-brand-sage uppercase tracking-wider">Current PIN</span>
                        <input
                          type="password"
                          inputMode="numeric"
                          maxLength={security.pinLength || 8}
                          value={currentPin}
                          onChange={(e) => setCurrentPin(e.target.value.replace(/\D/g, '').slice(0, security.pinLength || 8))}
                          placeholder="Current"
                          className="bg-brand-bg text-sm text-brand-plum border border-brand-border p-2.5 rounded-xl focus:outline-none"
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <span className="text-[10px] font-bold text-brand-sage uppercase tracking-wider">New PIN</span>
                        <input 
                          type="password" 
                          inputMode="numeric"
                          maxLength={newPinLength}
                          value={newPin}
                          onChange={(e) => setNewPin(e.target.value.replace(/\D/g, '').slice(0, newPinLength))}
                          placeholder={`${newPinLength} digits`}
                          className="bg-brand-bg text-sm text-brand-plum border border-brand-border p-2.5 rounded-xl focus:outline-none"
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <span className="text-[10px] font-bold text-brand-sage uppercase tracking-wider">Confirm PIN</span>
                        <input 
                          type="password" 
                          inputMode="numeric"
                          maxLength={newPinLength}
                          value={confirmPin}
                          onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, '').slice(0, newPinLength))}
                          placeholder="Confirm digits"
                          className="bg-brand-bg text-sm text-brand-plum border border-brand-border p-2.5 rounded-xl focus:outline-none"
                        />
                      </div>
                    </div>

                    {pinError && <p className="text-[11px] font-bold text-brand-pink-dark text-center">{pinError}</p>}
                    {pinSuccess && <p className="text-[11px] font-bold text-brand-sage text-center flex items-center justify-center gap-1"><Check className="w-4 h-4" /> Security PIN updated successfully!</p>}

                    <button
                      type="submit"
                      disabled={!isValidPin(currentPin, security.pinLength) || !isValidPin(newPin, newPinLength) || newPin !== confirmPin}
                      className="w-full py-2 bg-brand-sage hover:bg-brand-sage-dark disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold text-xs rounded-xl shadow-sm transition-colors"
                    >
                      Save Security Code
                    </button>
                  </form>
                )}
              </div>

              {/* Security question card */}
              <div className="bg-brand-card-bg p-5 rounded-3xl journal-shadow border border-brand-border flex flex-col gap-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <span className="p-2.5 bg-brand-blush-light dark:bg-brand-blush-light/10 text-brand-pink rounded-2xl">
                      <ShieldCheck className="w-4 h-4" />
                    </span>
                    <div>
                      <h3 className="text-sm font-bold text-brand-plum">Security Question</h3>
                      <p className="text-[10px] text-brand-sage mt-0.5">
                        {security.isPinCreated ? getRecoveryQuestionText(security) : 'Create a PIN before adding recovery'}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleToggleRecoveryForm}
                    disabled={!security.isPinCreated}
                    className="px-4 py-2 bg-brand-bg hover:bg-brand-rose-light disabled:opacity-40 disabled:cursor-not-allowed text-xs font-bold text-brand-sage-dark rounded-full border border-brand-border transition-colors"
                  >
                    {showRecoveryForm ? 'Close' : security.recoveryQuestionId ? 'Modify' : 'Add'}
                  </button>
                </div>

                {showRecoveryForm && (
                  <form onSubmit={handleRecoveryQuestionSubmit} className="mt-3 pt-3 border-t border-brand-border flex flex-col gap-3">
                    <label className="flex flex-col gap-1">
                      <span className="text-[10px] font-bold text-brand-sage uppercase tracking-wider">Question</span>
                      <select
                        value={recoveryQuestionId}
                        onChange={(e) => {
                          setRecoveryQuestionId(e.target.value);
                          setRecoveryError('');
                        }}
                        className="bg-brand-bg text-sm text-brand-plum border border-brand-border p-2.5 rounded-xl focus:outline-none focus:border-brand-pink"
                      >
                        {SECURITY_RECOVERY_QUESTIONS.map(q => (
                          <option key={q.id} value={q.id}>{q.question}</option>
                        ))}
                        <option value={CUSTOM_QUESTION_SELECT_VALUE}>Write my own question</option>
                      </select>
                    </label>

                    {recoveryQuestionId === CUSTOM_QUESTION_SELECT_VALUE && (
                      <label className="flex flex-col gap-1">
                        <span className="text-[10px] font-bold text-brand-sage uppercase tracking-wider">Custom Question</span>
                        <input
                          type="text"
                          value={customRecoveryQuestion}
                          onChange={(e) => setCustomRecoveryQuestion(e.target.value)}
                          placeholder="Type your security question"
                          className="bg-brand-bg text-sm text-brand-plum border border-brand-border p-2.5 rounded-xl focus:outline-none focus:border-brand-pink"
                        />
                      </label>
                    )}

                    <label className="flex flex-col gap-1">
                      <span className="text-[10px] font-bold text-brand-sage uppercase tracking-wider">Answer</span>
                      <div className="relative">
                        <input
                          type={showSecurityAnswer ? 'text' : 'password'}
                          value={securityAnswer}
                          onChange={(e) => setSecurityAnswer(e.target.value)}
                          placeholder="Enter a memorable answer"
                          className="w-full bg-brand-bg text-sm text-brand-plum border border-brand-border p-2.5 pr-10 rounded-xl focus:outline-none focus:border-brand-pink"
                        />
                        <button
                          type="button"
                          onClick={() => setShowSecurityAnswer(prev => !prev)}
                          className="absolute inset-y-0 right-2 flex items-center text-brand-sage hover:text-brand-pink"
                          title={showSecurityAnswer ? 'Hide answer' : 'Show answer'}
                        >
                          {showSecurityAnswer ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      </div>
                    </label>

                    {recoveryError && <p className="text-[11px] font-bold text-brand-pink-dark text-center">{recoveryError}</p>}
                    {recoverySuccess && <p className="text-[11px] font-bold text-brand-sage text-center flex items-center justify-center gap-1"><Check className="w-4 h-4" /> Security question updated successfully!</p>}

                    <button
                      type="submit"
                      disabled={!securityAnswer.trim() || (recoveryQuestionId === CUSTOM_QUESTION_SELECT_VALUE && !customRecoveryQuestion.trim())}
                      className="w-full py-2 bg-brand-sage hover:bg-brand-sage-dark disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold text-xs rounded-xl shadow-sm transition-colors"
                    >
                      Save Security Question
                    </button>
                  </form>
                )}
              </div>

              <div className="bg-brand-card-bg p-5 rounded-3xl journal-shadow border border-brand-border flex flex-col gap-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="p-2.5 bg-brand-blush-light dark:bg-brand-blush-light/10 text-brand-pink rounded-2xl">
                      <Cloud className="w-4 h-4" />
                    </span>
                    <div className="min-w-0">
                      <h3 className="text-sm font-bold text-brand-plum">Google PIN Recovery</h3>
                      <p className="text-[10px] text-brand-sage mt-0.5 break-words">
                        {security.linkedGoogleEmail || 'No recovery account linked'}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleLinkRecoveryAccount}
                    disabled={!security.isPinCreated || isRecoveryAccountLoading}
                    className="shrink-0 px-4 py-2 bg-brand-bg hover:bg-brand-rose-light disabled:opacity-40 disabled:cursor-not-allowed text-xs font-bold text-brand-sage-dark rounded-full border border-brand-border transition-colors"
                  >
                    {isRecoveryAccountLoading ? 'Linking...' : security.linkedGoogleUserId ? 'Verify' : 'Link'}
                  </button>
                </div>
                <p className="text-[10px] text-brand-text-muted leading-relaxed">
                  This account can verify a forgotten PIN. It is stored locally and remains separate from Google Drive backup.
                </p>
                {recoveryAccountError && (
                  <p className="text-[11px] font-bold text-brand-pink-dark">{recoveryAccountError}</p>
                )}
              </div>

              {/* Passkey & Biometric settings card */}
              <div className="bg-brand-card-bg p-5 rounded-3xl journal-shadow border border-brand-border flex flex-col gap-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="p-2.5 bg-brand-blush-light dark:bg-brand-blush-light/10 text-brand-pink rounded-2xl">
                      <Fingerprint className="w-4 h-4 text-brand-pink" />
                    </span>
                    <div>
                      <h3 className="text-sm font-bold text-brand-plum">Passkey & Biometrics</h3>
                      <p className="text-[10px] text-brand-sage mt-0.5">Secure your entries with device authenticators</p>
                    </div>
                  </div>

                  <label className="relative inline-flex items-center cursor-pointer">
                    <input 
                      type="checkbox" 
                      checked={security.isBiometricsEnabled}
                      onChange={(e) => handleToggleBiometrics(e.target.checked)}
                      disabled={isWebAuthnLoading}
                      className="sr-only peer" 
                    />
                    <div className="w-11 h-6 bg-brand-sage-light/50 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-brand-sage-light after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-brand-sage" />
                  </label>
                </div>

                {/* WebAuthn Details / Success / Error feedback */}
                <div className="text-xs space-y-2 leading-relaxed">
                  {isWebAuthnLoading && (
                    <p className="text-[11px] text-brand-sage animate-pulse">
                      {isNativePlatform()
                        ? 'Confirm the Android biometric prompt to enable fingerprint unlock...'
                        : 'Please follow your browser prompt to register your device passkey...'}
                    </p>
                  )}
                  
                  {webAuthnSuccess && (
                    <div className="p-2.5 bg-brand-sage/5 border border-brand-sage/20 text-brand-sage-dark rounded-xl font-medium">
                      {webAuthnSuccess}
                      {security.isBiometricsSimulated && (
                        <span className="block text-[9px] mt-1 font-bold text-brand-sage-dark/70 uppercase tracking-wider">
                          âš¡ Running in Preview Sandbox Simulation
                        </span>
                      )}
                    </div>
                  )}

                  {webAuthnError && (
                    <div className="p-2.5 bg-brand-pink/5 border border-brand-pink/20 text-brand-pink-dark rounded-xl text-[11px] font-medium leading-normal space-y-2">
                      <p>{webAuthnError}</p>
                      {showSimulateFallback && (
                        <button
                          type="button"
                          onClick={handleEnableSimulatedBiometrics}
                          className="w-full py-1.5 bg-brand-pink hover:bg-brand-pink-dark text-white rounded-lg font-bold text-[10px] uppercase tracking-wider transition-all"
                        >
                          Use Simulated Passkey (for Preview)
                        </button>
                      )}
                    </div>
                  )}

                  {security.isBiometricsEnabled ? (
                    <div className="p-2 bg-brand-bg/50 dark:bg-brand-bg/10 rounded-xl text-[10px] text-brand-sage flex items-center gap-1.5 border border-brand-border/30">
                      <span className="w-1.5 h-1.5 rounded-full bg-brand-sage animate-pulse" />
                      <span>
                        {security.isBiometricsSimulated 
                          ? 'Simulated Biometric Lock is Active.' 
                          : isNativePlatform()
                            ? 'Native biometric unlock is active.'
                            : 'Real hardware-backed WebAuthn Passkey is Active.'}
                      </span>
                    </div>
                  ) : (
                    <p className="text-[10px] text-brand-sage">
                      {isNativePlatform()
                        ? 'Enable after adding a fingerprint or strong biometric in Android Settings. PIN remains your primary backup and is removed by Android Clear storage.'
                        : "Enrolling triggers your browser's native credential manager (Windows Hello, Face ID, or Touch ID). PIN is required as your primary backup."}
                    </p>
                  )}
                </div>
              </div>
            </motion.div>
          )}

          {activeTab === 'backup' && (
            <motion.div
              key="backup"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.15 }}
              className="flex flex-col gap-5"
            >
              {/* Google Drive Backup card */}
              {backupSession ? (
                <>
                  <div className="bg-gradient-to-br from-brand-card-bg to-brand-bg/60 p-6 rounded-3xl journal-shadow border border-brand-border flex flex-col gap-5 relative overflow-hidden group">
                    {/* Glowing background aura */}
                    <div className={`absolute -right-16 -top-16 w-36 h-36 rounded-full blur-3xl opacity-20 dark:opacity-30 transition-colors duration-700 ${isBackupStale ? 'bg-amber-500' : 'bg-brand-sage'}`} />

                    <div className="flex items-center justify-between relative z-10">
                      <div className="flex items-center gap-3">
                        <span className={`p-3 rounded-2xl flex items-center justify-center transition-all duration-300 ${
                          isBackupStale
                            ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 animate-pulse' 
                            : 'bg-brand-sage/10 text-brand-sage'
                        }`}>
                          <Cloud className="w-5 h-5" />
                        </span>
                        <div>
                          <h3 className="text-sm font-bold text-brand-plum dark:text-brand-text">Google Drive Backup</h3>
                          <p className="text-[10px] text-brand-sage mt-0.5">Hidden appDataFolder backup for this device</p>
                        </div>
                      </div>

                      <div className="flex flex-col items-end">
                        {isBackupStale ? (
                          <div className="px-3 py-1 bg-amber-500/10 text-amber-600 dark:text-amber-400 text-[10px] font-bold rounded-full flex items-center gap-1.5 border border-amber-500/20 shadow-sm animate-pulse">
                            <span className="w-1.5 h-1.5 bg-amber-500 rounded-full" />
                            Backup Pending
                          </div>
                        ) : (
                          <div className="px-3 py-1 bg-brand-sage/10 text-brand-sage text-[10px] font-bold rounded-full flex items-center gap-1.5 border border-brand-sage/20 shadow-sm">
                            <span className="w-1.5 h-1.5 bg-brand-sage rounded-full" />
                            Backed Up
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-col gap-3.5 bg-brand-bg/55 dark:bg-brand-bg/15 p-4 rounded-2xl border border-brand-border/40 relative z-10 text-xs">
                      <div className="flex justify-between items-center">
                        <span className="text-brand-sage font-medium">Vault Account</span>
                        <span className="font-mono font-bold text-brand-plum dark:text-brand-text text-[11px] truncate max-w-[200px] flex items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-brand-sage animate-pulse" />
                          {backupAccountEmail}
                        </span>
                      </div>

                      <div className="flex justify-between items-center border-t border-brand-border/25 pt-3">
                        <span className="text-brand-sage font-medium">Last Backup</span>
                        <span className="font-mono text-brand-sage font-bold text-[11px] flex items-center gap-1">
                          <RefreshCw className="w-3 h-3 text-brand-sage/60 animate-spin" style={{ animationDuration: '6s' }} />
                          {lastBackupStr}
                        </span>
                      </div>

                      {isBackupStale && (
                        <div className="text-[10px] text-amber-700 dark:text-amber-400 bg-amber-500/5 border border-amber-500/10 p-3 rounded-xl flex items-start gap-2.5 leading-normal mt-1 animate-fade-in">
                          <FileWarning className="w-4 h-4 shrink-0 mt-0.5" />
                          <p>
                            Your device has entries or notes created after the last Drive backup.
                            Press <strong>Back Up Now</strong> to secure them.
                          </p>
                        </div>
                      )}
                    </div>

                    {/* Cloud Storage Usage Breakdown */}
                    <div className="border-t border-brand-border/30 pt-5 flex flex-col gap-3 relative z-10">
                      <div className="flex justify-between items-center text-xs">
                        <span className="text-brand-plum dark:text-brand-text font-bold">Estimated Backup Payload</span>
                        <span className="font-mono text-[11px] font-bold text-brand-pink">
                          {((storageDetails.totalBytes / (1024 * 1024 * 1024)) * 100).toFixed(1)}%
                        </span>
                      </div>
                      <div className="text-[10px] text-brand-sage text-right font-mono -mt-1 mb-1">
                         {formatBytes(storageDetails.totalBytes)}
                      </div>

                      {/* Progress bar representing actual space taken against 1GB */}
                      <div className="w-full h-3 bg-brand-bg dark:bg-brand-bg/50 rounded-full overflow-hidden border border-brand-border/30 flex shadow-inner">
                        {storageDetails.totalBytes > 0 ? (
                          <>
                            {/* Text & Metadata segment */}
                            <div 
                              style={{ width: `${Math.max(1.5, (storageDetails.textBytes / (1024 * 1024 * 1024)) * 100)}%` }} 
                              className="h-full bg-brand-sage transition-all duration-500 rounded-l-full"
                              title={`Text: ${formatBytes(storageDetails.textBytes)}`}
                            />
                            {/* Photos segment */}
                            {storageDetails.photoBytes > 0 && (
                              <div 
                                style={{ width: `${(storageDetails.photoBytes / (1024 * 1024 * 1024)) * 100}%` }} 
                                className="h-full bg-brand-pink border-l border-brand-card-bg/20 transition-all duration-500"
                                title={`Photos: ${formatBytes(storageDetails.photoBytes)}`}
                              />
                            )}
                            {/* Audio segment */}
                            {storageDetails.audioBytes > 0 && (
                              <div 
                                style={{ width: `${(storageDetails.audioBytes / (1024 * 1024 * 1024)) * 100}%` }} 
                                className="h-full bg-amber-500 border-l border-brand-card-bg/20 transition-all duration-500 rounded-r-full"
                                title={`Audio: ${formatBytes(storageDetails.audioBytes)}`}
                              />
                            )}
                          </>
                        ) : (
                          <div className="h-full bg-brand-border/30 w-full rounded-full" />
                        )}
                      </div>

                      {/* Legend Cards */}
                      <div className="grid grid-cols-3 gap-2 text-[9px] text-brand-sage leading-tight mt-0.5">
                        <div className="flex flex-col bg-brand-bg/40 dark:bg-brand-bg/15 p-2 rounded-xl border border-brand-border/20 shadow-sm">
                          <span className="flex items-center gap-1.5 font-bold text-brand-plum dark:text-brand-text mb-0.5">
                            <span className="w-1.5 h-1.5 rounded-full bg-brand-sage shrink-0" />
                            Text & Logs
                          </span>
                          <span className="font-mono text-brand-text-muted/95 pl-3">{formatBytes(storageDetails.textBytes)}</span>
                        </div>

                        <div className="flex flex-col bg-brand-bg/40 dark:bg-brand-bg/15 p-2 rounded-xl border border-brand-border/20 shadow-sm">
                          <span className="flex items-center gap-1.5 font-bold text-brand-plum dark:text-brand-text mb-0.5">
                            <span className="w-1.5 h-1.5 rounded-full bg-brand-pink shrink-0" />
                            Photos
                          </span>
                          <span className="font-mono text-brand-text-muted/95 pl-3">{formatBytes(storageDetails.photoBytes)}</span>
                        </div>

                        <div className="flex flex-col bg-brand-bg/40 dark:bg-brand-bg/15 p-2 rounded-xl border border-brand-border/20 shadow-sm">
                          <span className="flex items-center gap-1.5 font-bold text-brand-plum dark:text-brand-text mb-0.5">
                            <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />
                            Audio Notes
                          </span>
                          <span className="font-mono text-brand-text-muted/95 pl-3">{formatBytes(storageDetails.audioBytes)}</span>
                        </div>
                      </div>

                      <p className="text-[8px] text-brand-sage italic text-center mt-1 leading-relaxed">
                        Drive backup stores a zipped snapshot in the hidden Google Drive app data folder.
                      </p>
                    </div>

                    {/* Primary control buttons */}
                    <div className="grid grid-cols-2 gap-3 pt-3">
                      <button
                        type="button"
                        onClick={handleCreateDriveBackup}
                        disabled={isBackingUp || isRestoring}
                        className="py-3 bg-brand-pink hover:bg-brand-pink-dark text-white font-bold text-xs rounded-xl flex items-center justify-center gap-2 transition-all shadow-md shadow-brand-pink/15 active:scale-[0.98] disabled:opacity-50 select-none cursor-pointer"
                      >
                        <Upload className={`w-3.5 h-3.5 ${isBackingUp ? 'animate-pulse' : ''}`} />
                        {isBackingUp ? 'Backing Up...' : 'Back Up Now'}
                      </button>
                      <button
                        type="button"
                        onClick={handleSignOutClick}
                        className="py-3 border border-brand-border hover:bg-brand-rose-light/10 text-brand-text-muted hover:text-brand-pink-dark font-bold text-xs rounded-xl flex items-center justify-center gap-2 transition-all select-none cursor-pointer"
                      >
                        <LogOut className="w-3.5 h-3.5" />
                        Sign Out
                      </button>
                    </div>
                  </div>
                </>
              ) : (
                <div className="bg-brand-card-bg p-6 rounded-3xl journal-shadow border border-brand-border flex flex-col gap-5">
                  <div className="flex items-center gap-3">
                    <span className="p-2.5 bg-brand-blush-light dark:bg-brand-blush-light/10 text-brand-pink rounded-2xl">
                      <Cloud className="w-4 h-4" />
                    </span>
                    <div>
                      <h3 className="text-sm font-bold text-brand-plum dark:text-brand-text">Optional Google Drive Backup</h3>
                      <p className="text-[10px] text-brand-sage mt-0.5">Stay fully offline, or connect Google to back up this device</p>
                    </div>
                  </div>

                  <div className="text-[10.5px] leading-relaxed text-brand-text bg-brand-bg/30 dark:bg-white/5 p-3.5 rounded-2xl border border-brand-border/30">
                    <div className="flex gap-2.5 items-start">
                      <ShieldCheck className="w-4 h-4 text-brand-sage shrink-0 mt-0.5" />
                      <p className="text-brand-text-muted">
                        Google sign-in only enables hidden Drive backups. Your local PIN and security question stay on this device.
                        {driveBackupSettings.linkedGoogleEmail ? ` Last backup account: ${driveBackupSettings.linkedGoogleEmail}.` : ''}
                      </p>
                    </div>
                  </div>

                  {authError && (
                    <p className="text-[10px] font-bold text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/20 p-3 rounded-2xl border border-red-100/50 dark:border-red-900/50 leading-normal text-center">
                      {authError}
                    </p>
                  )}

                  <button
                    type="button"
                    onClick={handleGoogleSignIn}
                    disabled={isAuthLoading}
                    className="w-full py-3.5 bg-brand-sage hover:bg-brand-sage-dark text-white font-bold text-xs rounded-xl shadow-md shadow-brand-sage/10 transition-all active:scale-[0.98] disabled:opacity-50 select-none cursor-pointer flex items-center justify-center gap-2"
                  >
                    {isAuthLoading ? (
                      <>
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        <span>Connecting Google...</span>
                      </>
                    ) : (
                      <>
                        <Cloud className="w-4 h-4" />
                        <span>{driveBackupSettings.linkedGoogleEmail ? 'Reconnect Google Drive Backup' : 'Connect Google Drive Backup'}</span>
                      </>
                    )}
                  </button>
                </div>
              )}

              {backupSession && (
                <div className="bg-brand-card-bg p-5 rounded-3xl journal-shadow border border-brand-border flex flex-col gap-3">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-xs font-bold text-brand-sage uppercase tracking-wider">Drive Backups</h3>
                    <button
                      type="button"
                      onClick={() => refreshDriveBackups()}
                      disabled={isLoadingBackups}
                      className="px-3 py-1.5 rounded-full border border-brand-border text-brand-sage text-[10px] font-bold flex items-center gap-1.5 disabled:opacity-50"
                    >
                      <RefreshCw className={`w-3 h-3 ${isLoadingBackups ? 'animate-spin' : ''}`} />
                      Refresh
                    </button>
                  </div>

                  {driveBackups.length === 0 ? (
                    <p className="text-[10px] text-brand-text-muted bg-brand-bg/40 dark:bg-brand-bg/15 p-3 rounded-2xl border border-brand-border/30">
                      No Drive backups found yet. Create one from this device when you are ready.
                    </p>
                  ) : (
                    <div className="flex flex-col gap-2">
                      {driveBackups.map(backup => (
                        <div key={backup.id} className="flex items-center justify-between gap-3 p-3 rounded-2xl bg-brand-bg/40 dark:bg-brand-bg/15 border border-brand-border/30">
                          <div className="min-w-0">
                            <p className="text-xs font-bold text-brand-plum dark:text-brand-text truncate">{backup.name}</p>
                            <p className="text-[10px] text-brand-sage">
                              {backup.createdTime ? new Date(backup.createdTime).toLocaleString() : 'Unknown date'}
                              {backup.size ? ` - ${formatBytes(backup.size)}` : ''}
                            </p>
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            <button
                              type="button"
                              onClick={() => handleRestoreDriveBackup(backup.id)}
                              disabled={isRestoring || isBackingUp}
                              className="p-2 rounded-xl bg-brand-sage/10 text-brand-sage hover:bg-brand-sage hover:text-white transition-colors disabled:opacity-50"
                              title="Restore backup"
                            >
                              <Download className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeleteDriveBackup(backup.id)}
                              disabled={isRestoring || isBackingUp}
                              className="p-2 rounded-xl bg-red-50 text-red-600 hover:bg-red-600 hover:text-white transition-colors disabled:opacity-50"
                              title="Delete backup"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Encrypted local backups section */}
              <div className="bg-brand-card-bg p-5 rounded-3xl journal-shadow border border-brand-border flex flex-col gap-3">
                <h3 className="text-xs font-bold text-brand-sage uppercase tracking-wider mb-1">Advanced Local Export</h3>
                <p className="text-[10px] text-brand-text-muted leading-relaxed">
                  Optional password-protected file export for manual safekeeping outside Google Drive.
                </p>
                
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={() => { setShowBackupModal(true); setBackupMsg(''); }}
                    className="py-3 bg-brand-sage-light/20 hover:bg-brand-sage-light/40 border border-brand-sage-light text-brand-sage-dark text-xs font-bold rounded-2xl flex flex-col items-center gap-1.5 transition-all shadow-sm"
                  >
                    <Download className="w-4 h-4" />
                    Export File
                  </button>
                  <button
                    onClick={() => { setShowImportModal(true); setImportError(''); }}
                    className="py-3 bg-brand-blush-light hover:bg-brand-blush-dark border border-brand-rose-light text-brand-pink-dark text-xs font-bold rounded-2xl flex flex-col items-center gap-1.5 transition-all shadow-sm"
                  >
                    <Upload className="w-4 h-4" />
                    Import File
                  </button>
                </div>
              </div>

              {/* Danger Reset database button */}
              <div className="bg-red-50/50 p-5 rounded-3xl border border-red-100 flex flex-col gap-3 mt-4">
                <div className="flex items-center gap-2 text-red-700">
                  <FileWarning className="w-4 h-4" />
                  <h3 className="text-xs font-bold uppercase tracking-wider">Wipe Journal Data</h3>
                </div>
                <p className="text-[11px] text-red-600/90 leading-relaxed">
                  Resetting clears all entries, notes, and photo references. Your security PIN, Google backup link, and reminder preferences will remain untouched.
                </p>

                {!showConfirmReset ? (
                  <button
                    onClick={() => setShowConfirmReset(true)}
                    className="py-2.5 bg-red-100 hover:bg-red-200 text-red-700 text-xs font-bold rounded-xl transition-all flex items-center justify-center gap-1.5"
                  >
                    <Trash2 className="w-4 h-4" />
                    Reset All Journal Content
                  </button>
                ) : (
                  <div className="flex flex-col gap-2 bg-brand-card-bg p-3.5 rounded-2xl border border-brand-border shadow-sm">
                    <p className="text-[11px] font-bold text-red-700 text-center">Are you completely sure? This cannot be undone.</p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setShowConfirmReset(false)}
                        className="flex-1 py-1.5 border border-red-200 text-red-700 rounded-lg text-[10px] font-bold"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={handleResetDatabase}
                        className="flex-1 py-1.5 bg-red-600 hover:bg-red-700 text-white rounded-lg text-[10px] font-bold transition-colors"
                      >
                        Confirm Reset
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </motion.div>
          )}

          {activeTab === 'customize' && (
            <motion.div
              key="customize"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.15 }}
              className="flex flex-col gap-5"
            >
              {/* App Theme Selector */}
              <div className="bg-brand-card-bg p-5 rounded-3xl journal-shadow border border-brand-border flex flex-col gap-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="p-2.5 bg-brand-blush-light dark:bg-brand-blush-light/10 text-brand-pink rounded-2xl">
                      {settings.theme === 'dark' ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
                    </span>
                    <div>
                      <h3 className="text-sm font-bold text-brand-plum">Application Theme</h3>
                      <p className="text-[10px] text-brand-sage mt-0.5">Toggle between Light and Dark mode</p>
                    </div>
                  </div>
                </div>
                
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={() => handleThemeChange('light')}
                    className={`flex items-center justify-center gap-2 py-3 rounded-2xl border text-xs font-bold transition-all ${
                      settings.theme !== 'dark'
                        ? 'bg-brand-pink text-white border-brand-pink scale-[1.01] shadow-sm'
                        : 'bg-brand-bg text-brand-sage border-brand-border hover:bg-brand-blush-light dark:hover:bg-brand-blush-light/10'
                    }`}
                  >
                    <Sun className="w-4 h-4" />
                    Light Mode
                  </button>
                  <button
                    onClick={() => handleThemeChange('dark')}
                    className={`flex items-center justify-center gap-2 py-3 rounded-2xl border text-xs font-bold transition-all ${
                      settings.theme === 'dark'
                        ? 'bg-brand-pink text-white border-brand-pink scale-[1.01] shadow-sm'
                        : 'bg-brand-bg text-brand-sage border-brand-border hover:bg-brand-blush-light dark:hover:bg-brand-blush-light/10'
                    }`}
                  >
                    <Moon className="w-4 h-4" />
                    Dark Mode
                  </button>
                </div>
              </div>

              {/* Custom Tags */}
              <div className="bg-brand-card-bg p-5 rounded-3xl journal-shadow border border-brand-border flex flex-col gap-4">
                <div className="flex items-center gap-3 mb-2">
                  <span className="p-2.5 bg-brand-blush-light dark:bg-brand-blush-light/10 text-brand-pink rounded-2xl">
                    <Tag className="w-4 h-4" />
                  </span>
                  <div>
                    <h3 className="text-sm font-bold text-brand-plum">Custom Tags</h3>
                    <p className="text-[10px] text-brand-sage mt-0.5">Add your own categories</p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {customTags.map((tag) => (
                    <span key={tag} className="flex items-center gap-1.5 px-3 py-1 bg-brand-bg border border-brand-border rounded-full text-xs font-semibold text-brand-sage-dark">
                      #{tag}
                      <button type="button" onClick={() => handleRemoveCustomTag(tag)} className="text-brand-pink hover:text-brand-pink-dark">
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                  {customTags.length === 0 && (
                    <p className="text-xs text-brand-sage italic">No custom tags added yet.</p>
                  )}
                </div>
                <div className="flex gap-2">
                  <input 
                    type="text" 
                    value={newTagInput}
                    onChange={(e) => setNewTagInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleAddCustomTag()}
                    placeholder="New tag name"
                    className="flex-1 bg-brand-bg border border-brand-border p-2 rounded-xl text-xs text-brand-plum focus:outline-none focus:border-brand-pink"
                  />
                  <button 
                    onClick={handleAddCustomTag}
                    disabled={!newTagInput.trim()}
                    className="p-2 bg-brand-sage hover:bg-brand-sage-dark disabled:bg-brand-sage-light text-white rounded-xl transition-colors"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Custom Moods */}
              <div className="bg-brand-card-bg p-5 rounded-3xl journal-shadow border border-brand-border flex flex-col gap-4">
                <div className="flex items-center gap-3 mb-2">
                  <span className="p-2.5 bg-brand-blush-light dark:bg-brand-blush-light/10 text-brand-pink rounded-2xl">
                    <Smile className="w-4 h-4" />
                  </span>
                  <div>
                    <h3 className="text-sm font-bold text-brand-plum">Custom Moods</h3>
                    <p className="text-[10px] text-brand-sage mt-0.5">Add your own moods with emojis</p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {customMoods.map((mood) => (
                    <span key={mood.name} className="flex items-center gap-1.5 px-3 py-1.5 bg-brand-bg border border-brand-border rounded-full text-xs font-semibold text-brand-sage-dark">
                      <span>{mood.emoji}</span>
                      <span>{mood.name}</span>
                      <button type="button" onClick={() => handleRemoveCustomMood(mood.name)} className="text-brand-pink hover:text-brand-pink-dark ml-1">
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                  {customMoods.length === 0 && (
                    <p className="text-xs text-brand-sage italic">No custom moods added yet.</p>
                  )}
                </div>
                <div className="flex gap-2">
                  <input 
                    type="text" 
                    value={newMoodEmojiInput}
                    onChange={(e) => setNewMoodEmojiInput(e.target.value)}
                    placeholder="Emoji"
                    className="w-24 bg-brand-bg text-brand-plum border border-brand-border p-2 rounded-xl text-xs focus:outline-none focus:border-brand-pink"
                  />
                  <input 
                    type="text" 
                    value={newMoodNameInput}
                    onChange={(e) => setNewMoodNameInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleAddCustomMood()}
                    placeholder="Mood name"
                    className="flex-1 bg-brand-bg text-brand-plum border border-brand-border p-2 rounded-xl text-xs focus:outline-none focus:border-brand-pink"
                  />
                  <button 
                    onClick={handleAddCustomMood}
                    disabled={!newMoodNameInput.trim() || !newMoodEmojiInput.trim()}
                    className="p-2 bg-brand-sage hover:bg-brand-sage-dark disabled:bg-brand-sage-light text-white rounded-xl transition-colors"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* EXPORT BACKUP OVERLAY MODAL */}
      {showBackupModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-md">
          <div className="w-full max-w-sm bg-brand-card-bg rounded-3xl p-6 journal-shadow border border-brand-border flex flex-col gap-4">
            <div>
              <h3 className="font-serif-diary text-lg font-bold text-brand-plum">Export Protected Backup</h3>
              <p className="text-xs text-brand-sage mt-1">
                Enter a password to encrypt your diary export. You will need this password to restore the backup file.
              </p>
            </div>
 
            <div className="flex flex-col gap-1">
              <span className="text-[10px] font-bold text-brand-sage uppercase tracking-wider">Backup Password</span>
              <input 
                type="password" 
                value={backupPassword}
                onChange={(e) => setBackupPassword(e.target.value)}
                placeholder="Enter strong password..."
                className="bg-brand-bg text-sm text-brand-plum border border-brand-border p-2.5 rounded-xl focus:outline-none"
              />
            </div>
 
            {backupMsg && <p className="text-[11px] font-bold text-center text-brand-pink-dark">{backupMsg}</p>}
 
            <div className="flex gap-3 pt-2">
              <button
                onClick={() => setShowBackupModal(false)}
                className="flex-1 py-2.5 rounded-full border border-brand-sage text-brand-sage font-bold text-xs"
              >
                Cancel
              </button>
              <button
                onClick={handleExportBackup}
                disabled={!backupPassword}
                className="flex-1 py-2.5 rounded-full bg-brand-sage text-white font-bold text-xs hover:bg-brand-sage-dark transition-colors"
              >
                Download Backup
              </button>
            </div>
          </div>
        </div>
      )}
 
      {/* IMPORT BACKUP OVERLAY MODAL */}
      {showImportModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-md">
          <div className="w-full max-w-sm bg-brand-card-bg rounded-3xl p-6 journal-shadow border border-brand-border flex flex-col gap-4">
            <div>
              <h3 className="font-serif-diary text-lg font-bold text-brand-plum">Restore Protected Backup</h3>
              <p className="text-xs text-brand-sage mt-1">
                Select a previously exported encrypted backup text file and provide its password to decrypt and restore.
              </p>
            </div>
 
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <span className="text-[10px] font-bold text-brand-sage uppercase tracking-wider">Select Backup File (.txt)</span>
                <input 
                  type="file" 
                  accept=".txt"
                  onChange={handleImportFileSelect}
                  className="text-xs text-brand-sage border border-brand-border p-2 rounded-xl focus:outline-none"
                />
              </div>
 
              <div className="flex flex-col gap-1">
                <span className="text-[10px] font-bold text-brand-sage uppercase tracking-wider">Decryption Password</span>
                <input 
                  type="password" 
                  value={importPassword}
                  onChange={(e) => setImportPassword(e.target.value)}
                  placeholder="Enter original password..."
                  className="bg-brand-bg text-sm text-brand-plum border border-brand-border p-2.5 rounded-xl focus:outline-none"
                />
              </div>
            </div>
 
            {importError && <p className="text-[11px] font-bold text-center text-brand-pink-dark">{importError}</p>}
 
            <div className="flex gap-3 pt-2">
              <button
                onClick={() => setShowImportModal(false)}
                className="flex-1 py-2.5 rounded-full border border-brand-sage text-brand-sage font-bold text-xs"
              >
                Cancel
              </button>
              <button
                onClick={handleImportBackup}
                disabled={!importFile || !importPassword}
                className="flex-1 py-2.5 rounded-full bg-brand-sage text-white font-bold text-xs hover:bg-brand-sage-dark transition-colors"
              >
                Restore Backup
              </button>
            </div>
          </div>
        </div>
      )}

      {/* DRIVE BACKUP PROGRESS MODAL */}
      {backupStep >= 0 && activeTab === 'backup' && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-md">
          <motion.div 
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="w-full max-w-sm bg-brand-card-bg rounded-3xl p-6 journal-shadow border border-brand-border flex flex-col gap-5 text-center"
          >
            {/* Spinning/pulsing radar animation */}
            <div className="relative flex items-center justify-center h-24 w-24 mx-auto mt-2">
              <motion.div 
                animate={{ scale: [1, 1.15, 1], opacity: [0.2, 0.4, 0.2] }}
                transition={{ repeat: Infinity, duration: 2, ease: "easeInOut" }}
                className="absolute inset-0 bg-brand-pink/10 rounded-full"
              />
              <motion.div 
                animate={{ scale: [1, 1.3, 1], opacity: [0.1, 0.25, 0.1] }}
                transition={{ repeat: Infinity, duration: 2.5, ease: "easeInOut", delay: 0.3 }}
                className="absolute inset-0 bg-brand-sage/10 rounded-full"
              />
              <div className="h-14 w-14 rounded-2xl bg-brand-pink/15 dark:bg-brand-pink/20 flex items-center justify-center text-brand-pink shadow-md relative z-10">
                <RefreshCw className="w-6 h-6 animate-spin" style={{ animationDuration: '3s' }} />
              </div>
            </div>

            <div>
              <h3 className="font-serif-diary text-base font-bold text-brand-plum dark:text-brand-text">Preparing Drive Backup</h3>
              <p className="text-[10px] text-brand-sage mt-1">Please keep the application open while the backup finishes.</p>
            </div>

            {/* Simulated Live Progress Bar */}
            <div className="w-full h-1.5 bg-brand-bg dark:bg-brand-bg/50 rounded-full overflow-hidden border border-brand-border/30">
              <motion.div 
                className="h-full bg-brand-pink"
                initial={{ width: "0%" }}
                animate={{ width: `${(backupStep + 1) * 25}%` }}
                transition={{ duration: 0.3, ease: "easeOut" }}
              />
            </div>

            {/* Steps Checklist */}
            <div className="flex flex-col gap-2.5 text-left mt-1.5 bg-brand-bg/40 dark:bg-white/5 p-3 rounded-2xl border border-brand-border/35">
              {[
                "Building local journal snapshot",
                "Uploading to hidden Drive app data",
                "Refreshing backup inventory",
                "Backup operation complete"
              ].map((stepText, index) => {
                const isCompleted = backupStep > index;
                const isCurrent = backupStep === index;

                return (
                  <div key={index} className={`flex items-center gap-2.5 text-[10.5px] transition-all duration-300 ${
                    isCompleted 
                      ? 'text-brand-sage font-bold' 
                      : isCurrent 
                      ? 'text-brand-pink font-bold animate-pulse' 
                      : 'text-brand-sage/40 font-medium'
                  }`}>
                    <div className="shrink-0">
                      {isCompleted ? (
                        <motion.span 
                          initial={{ scale: 0 }}
                          animate={{ scale: 1 }}
                          className="w-4 h-4 rounded-full bg-brand-sage/15 text-brand-sage flex items-center justify-center text-[9px] border border-brand-sage/35 font-bold"
                        >
                          âœ“
                        </motion.span>
                      ) : isCurrent ? (
                        <div className="w-4 h-4 flex items-center justify-center relative">
                          <span className="w-2 h-2 rounded-full bg-brand-pink animate-ping absolute" />
                          <span className="w-2 h-2 rounded-full bg-brand-pink relative z-10" />
                        </div>
                      ) : (
                        <div className="w-4 h-4 rounded-full border border-brand-border/40 flex items-center justify-center" />
                      )}
                    </div>
                    <span className="truncate">{stepText}</span>
                  </div>
                );
              })}
            </div>
          </motion.div>
        </div>
      )}
    </div>
  );
}
