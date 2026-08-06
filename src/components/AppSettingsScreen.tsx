import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import {
  ArrowLeft,
  Lock,
  Bell,
  Check,
  ShieldCheck,
  Refresh as RefreshCw,
  Plus,
  Label as Tag,
  Emoji as Smile,
  Xmark as X,
  SunLight as Sun,
  HalfMoon as Moon,
  Cloud,
  Fingerprint,
  Palette,
  Database,
  InfoCircle as Info,
  EditPencil as PenLine,
  NavArrowRight as ChevronRight,
  User,
  Mail,
  MediaImage as ImagePlus,
  Trash as Trash2,
} from 'iconoir-react';
import {
  AppSettings,
  LocalSyncAccountState,
  SecurityConfig,
  Mood,
  ResponsiveLayout,
  UserProfile,
} from '../types';
import { PREDEFINED_TAGS, PREDEFINED_MOODS, PREDEFINED_COLORS } from '../domain/journalCatalog';
import { BRAND } from '../config/brand';
import { isValidPin, updatePinWithCurrentPin } from '../domain/security';
import type { PinLength } from '../domain/security';
import { isNativePlatform } from '../platform';
import { secureAuthService } from '../platform/security';
import { diaryRepository, eventSyncEngine, syncV2Application } from '../repositories';
import { createDefaultUserProfile } from '../repositories/defaults';
import { pruneOrphanedMedia } from '../mobile/mediaGarbageCollector';
import { persistOptimizedImageFile } from '../mobile/mediaStorage';
import { isSupportedImageMimeType } from '../mobile/imageOptimization';
import {
  getReminderCapability,
  normalizeReminderTime,
  requestReminderPermission,
  type ReminderCapability,
} from '../mobile/reminders';
import ProfileAvatar from './ProfileAvatar';
import AvatarCropper from './AvatarCropper';
import CompanionApprovalPanel from './CompanionApprovalPanel';
import {
  isValidNewRecoveryPassphrase,
  RECOVERY_PASSPHRASE_DIGIT_LENGTH,
} from '../sync/e2eeKeyPackage';
import { rotateRecoveryPassphrase } from '../sync/recoveryPassphraseRotation';
import type { PreservedSyncConflict, SyncStatusSummary } from '../repositories';
import { useScreenPerformance } from '../hooks/useScreenPerformance';
import { pageMotion } from './ui/motion';
import { BottomSheet } from './ui/BottomSheet';
import {
  exportPrivacySafeSyncDiagnostics,
  getSyncHealthStatusMessage,
  type SyncHealth,
} from '../sync/health/SyncHealth';
import { DEFAULT_ACCENT_THEME_ID, type AccentThemeId } from '../design/accentThemes';
import AccentThemeSelector from './AccentThemeSelector';
import { calculateLocalStorageUsage, type LocalStorageUsage } from '../utils/localStorageUsage';

interface AppSettingsScreenProps {
  initialSettings: AppSettings;
  initialSecurity: SecurityConfig;
  initialProfile: UserProfile;
  layout?: ResponsiveLayout;
  initialSection?: SettingsSection;
  onBack: () => void;
  onResetSuccess: () => void | Promise<void>;
  onDataChanged: () => void | Promise<void>;
  onShowToast?: (message: string, type?: 'success' | 'info' | 'warning' | 'error') => void;
  onThemeChange?: (theme: 'light' | 'dark') => void;
  accentTheme?: AccentThemeId;
  onAccentThemeChange?: (accentTheme: AccentThemeId) => void;
}

export type SettingsSection =
  | 'profile'
  | 'appearance'
  | 'writing'
  | 'notifications'
  | 'privacy-security'
  | 'sync-backup'
  | 'data-storage'
  | 'about';

const sectionTab = (section: SettingsSection): 'profile' | 'security' | 'backup' | 'customize' => {
  if (section === 'privacy-security') return 'security';
  if (section === 'sync-backup' || section === 'data-storage') return 'backup';
  if (section === 'appearance' || section === 'writing' || section === 'notifications')
    return 'customize';
  return 'profile';
};

const SETTINGS_SECTIONS: Array<{
  id: SettingsSection;
  label: string;
  description: string;
  icon: typeof User;
}> = [
  {
    id: 'profile',
    label: 'Profile',
    description: 'Name, avatar, email, and writing target',
    icon: User,
  },
  {
    id: 'appearance',
    label: 'Appearance',
    description: 'Theme and visual preferences',
    icon: Palette,
  },
  {
    id: 'writing',
    label: 'Writing Preferences',
    description: 'Tags and mood vocabulary',
    icon: PenLine,
  },
  {
    id: 'notifications',
    label: 'Notifications',
    description: 'Daily writing reminders',
    icon: Bell,
  },
  {
    id: 'privacy-security',
    label: 'Privacy & Security',
    description: 'PIN and biometrics',
    icon: ShieldCheck,
  },
  {
    id: 'sync-backup',
    label: 'Sync & Devices',
    description: 'Connected account, sync health, and devices',
    icon: Cloud,
  },
  {
    id: 'data-storage',
    label: 'Data & Storage',
    description: 'Storage used on this device',
    icon: Database,
  },
  { id: 'about', label: 'About', description: 'App version and privacy principles', icon: Info },
];

const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

const formatDateTime = (value?: string | number | null): string =>
  value ? new Date(value).toLocaleString() : 'Never';

const syncAuthorizationMessage = (error: unknown, fallback: string): string => {
  const message = error instanceof Error ? error.message : String(error || '');
  if (/no credentials available/i.test(message)) {
    return 'Google could not reopen the linked account. Check Google Play Services, then try again.';
  }
  return message || fallback;
};

export default function AppSettingsScreen({
  initialSettings,
  initialSecurity,
  initialProfile,
  layout = 'mobile',
  initialSection,
  onBack,
  onResetSuccess,
  onDataChanged,
  onShowToast,
  onThemeChange,
  accentTheme = DEFAULT_ACCENT_THEME_ID,
  onAccentThemeChange,
}: AppSettingsScreenProps) {
  useScreenPerformance('settings');
  const prefersReducedMotion = useReducedMotion();
  const hasSidebar = layout !== 'mobile';
  const [security, setSecurity] = useState<SecurityConfig>(initialSecurity);
  const [settings, setSettings] = useState<AppSettings>(initialSettings);
  const [selectedSection, setSelectedSection] = useState<SettingsSection>(
    initialSection || 'profile',
  );
  const [activeTab, setActiveTab] = useState<'profile' | 'security' | 'backup' | 'customize'>(() =>
    sectionTab(initialSection || 'profile'),
  );
  const [mobileSectionOpen, setMobileSectionOpen] = useState(Boolean(initialSection));

  const openSection = (section: SettingsSection) => {
    setSelectedSection(section);
    setActiveTab(sectionTab(section));
    setMobileSectionOpen(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // User Profile States
  const [profile, setProfile] = useState<UserProfile>(initialProfile);
  const [profileName, setProfileName] = useState(profile.name);
  const [profileEmail] = useState(profile.email);
  const [profileBio, setProfileBio] = useState(profile.bio);
  const [profileEmoji, setProfileEmoji] = useState(profile.avatarEmoji);
  const [profileColor, setProfileColor] = useState(profile.avatarColor);
  const [profileAvatarUri, setProfileAvatarUri] = useState(profile.avatarUri);
  const [profileWritingGoal, setProfileWritingGoal] = useState(profile.writingGoal || 100);
  const [showAvatarEditor, setShowAvatarEditor] = useState(false);
  const [isSavingAvatar, setIsSavingAvatar] = useState(false);
  const [avatarError, setAvatarError] = useState('');
  const [pendingAvatarFile, setPendingAvatarFile] = useState<File | null>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);

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

  const [syncAccountState, setSyncAccountState] = useState<LocalSyncAccountState | null>(null);
  const [showSyncRecoveryForm, setShowSyncRecoveryForm] = useState(false);
  const [newRecoveryPassphrase, setNewRecoveryPassphrase] = useState('');
  const [confirmNewRecoveryPassphrase, setConfirmNewRecoveryPassphrase] = useState('');
  const [syncRecoveryError, setSyncRecoveryError] = useState('');
  const [isRotatingRecoveryPassphrase, setIsRotatingRecoveryPassphrase] = useState(false);
  const [localStorageUsage, setLocalStorageUsage] = useState<LocalStorageUsage | null>(null);
  const [isLocalStorageUsageLoading, setIsLocalStorageUsageLoading] = useState(false);
  const [localStorageUsageError, setLocalStorageUsageError] = useState('');
  const [syncStatus, setSyncStatus] = useState<SyncStatusSummary | null>(null);
  const [syncHealth, setSyncHealth] = useState<SyncHealth | null>(null);
  const [syncStatusError, setSyncStatusError] = useState('');
  const [isRetryingSync, setIsRetryingSync] = useState(false);
  const [preservedConflicts, setPreservedConflicts] = useState<PreservedSyncConflict[]>([]);
  const [conflictActionId, setConflictActionId] = useState('');

  // Reminders preference states
  const [reminderTime, setReminderTime] = useState<string>(() =>
    normalizeReminderTime(settings.reminderTime || '20:00'),
  );
  const [reminderCapability, setReminderCapability] = useState<ReminderCapability>({
    supported: isNativePlatform(),
    permission: isNativePlatform() ? 'prompt' : 'unsupported',
  });

  // Reset confirm state
  const [showConfirmReset, setShowConfirmReset] = useState<boolean>(false);
  const [isResettingContent, setIsResettingContent] = useState(false);
  const [resetContentError, setResetContentError] = useState('');
  const [showConfirmUnlink, setShowConfirmUnlink] = useState(false);
  const [isUnlinking, setIsUnlinking] = useState(false);

  // Encrypted sync authorization/status states
  const [authError, setAuthError] = useState('');
  const [isAuthLoading, setIsAuthLoading] = useState(false);

  // WebAuthn Passkey States
  const [isWebAuthnLoading, setIsWebAuthnLoading] = useState<boolean>(false);
  const [webAuthnError, setWebAuthnError] = useState<string>('');
  const [webAuthnSuccess, setWebAuthnSuccess] = useState<string>('');
  const [showSimulateFallback, setShowSimulateFallback] = useState<boolean>(false);

  useEffect(() => {
    void getReminderCapability().then(setReminderCapability);
  }, []);

  useEffect(() => {
    void diaryRepository.getLocalSyncAccountState().then(setSyncAccountState);
  }, []);

  const pendingSyncCount = syncStatus?.pendingOutboxCount || 0;
  const failedSyncCount = syncStatus?.failedOperationCount || 0;

  const reconnectSyncAccount = async (): Promise<void> => {
    setAuthError('');
    setIsAuthLoading(true);
    try {
      await eventSyncEngine.reauthorize();
      await refreshLocalSyncStatus();
      onShowToast?.('Encrypted sync authorization renewed.', 'success');
    } catch (error: any) {
      setAuthError(
        syncAuthorizationMessage(error, 'Encrypted sync authorization could not be renewed.'),
      );
    } finally {
      setIsAuthLoading(false);
    }
  };

  const refreshLocalStorageUsage = async (): Promise<void> => {
    setLocalStorageUsageError('');
    setIsLocalStorageUsageLoading(true);
    try {
      setLocalStorageUsage(
        await calculateLocalStorageUsage(await diaryRepository.exportSnapshot()),
      );
    } catch {
      setLocalStorageUsage(null);
      setLocalStorageUsageError('On-device usage could not be calculated.');
    } finally {
      setIsLocalStorageUsageLoading(false);
    }
  };

  const refreshLocalSyncStatus = async (): Promise<void> => {
    if (!syncAccountState) {
      setSyncStatus(null);
      setSyncHealth(await diaryRepository.getSyncHealth());
      setPreservedConflicts([]);
      return;
    }
    setSyncStatusError('');
    try {
      const [status, health, conflicts] = await Promise.all([
        diaryRepository.getSyncStatusSummary(),
        diaryRepository.getSyncHealth(),
        diaryRepository.listPreservedSyncConflicts(),
      ]);
      setSyncStatus(status);
      setSyncHealth(health);
      setPreservedConflicts(conflicts);
    } catch (error: any) {
      setSyncStatusError(error?.message || 'Local sync status could not be loaded.');
    }
  };

  const exportSyncDiagnostics = (): void => {
    if (!syncHealth) return;
    const diagnostics = exportPrivacySafeSyncDiagnostics(
      syncHealth,
      import.meta.env.VITE_APP_VERSION || '1.0.0',
      2,
    );
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(diagnostics, null, 2)], { type: 'application/json' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = 'loredays-sync-diagnostics.json';
    link.click();
    URL.revokeObjectURL(url);
  };

  const runConflictAction = async (
    operationId: string,
    action: () => Promise<void | boolean>,
    successMessage: string,
  ): Promise<void> => {
    setConflictActionId(operationId);
    setSyncStatusError('');
    try {
      await action();
      await refreshLocalSyncStatus();
      onShowToast?.(successMessage, 'success');
    } catch (error: any) {
      const message = error?.message || 'Conflict action could not be completed.';
      setSyncStatusError(message);
      onShowToast?.(message, 'warning');
    } finally {
      setConflictActionId('');
    }
  };

  const retryLocalSync = async (): Promise<void> => {
    if (!syncAccountState) return;
    setIsRetryingSync(true);
    setSyncStatusError('');
    try {
      await eventSyncEngine.flushPendingOutbox();
      await refreshLocalSyncStatus();
      onShowToast?.('Sync retry completed.', 'success');
    } catch (error: any) {
      const message = error?.message || 'Sync retry could not finish.';
      setSyncStatusError(message);
      onShowToast?.(message, 'warning');
      await refreshLocalSyncStatus().catch(() => undefined);
    } finally {
      setIsRetryingSync(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'backup') {
      void refreshLocalSyncStatus();
    }
  }, [activeTab, syncAccountState?.accountId]);

  useEffect(() => {
    if (selectedSection === 'data-storage') {
      void refreshLocalStorageUsage();
    }
  }, [selectedSection]);

  useEffect(
    () =>
      diaryRepository.subscribeChanges(() => {
        if (activeTab === 'backup') void refreshLocalSyncStatus();
      }),
    [activeTab, syncAccountState?.accountId],
  );

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

  const handleRotateRecoveryPassphrase = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setSyncRecoveryError('');
    if (newRecoveryPassphrase !== confirmNewRecoveryPassphrase) {
      setSyncRecoveryError('Recovery passphrases do not match.');
      return;
    }
    setIsRotatingRecoveryPassphrase(true);
    try {
      await rotateRecoveryPassphrase({
        newPassphrase: newRecoveryPassphrase,
        repository: diaryRepository,
        syncEngine: eventSyncEngine,
      });
      setNewRecoveryPassphrase('');
      setConfirmNewRecoveryPassphrase('');
      setShowSyncRecoveryForm(false);
      setSyncAccountState(await diaryRepository.getLocalSyncAccountState());
      onShowToast?.('Account recovery passphrase changed.', 'success');
    } catch (error: any) {
      setSyncRecoveryError(error?.message || 'Recovery passphrase could not be changed.');
    } finally {
      setIsRotatingRecoveryPassphrase(false);
    }
  };

  const handleThemeChange = (newTheme: 'light' | 'dark') => {
    setSettings((prev) => ({ ...prev, theme: newTheme }));
    onThemeChange?.(newTheme);
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
    const nextTags = customTags.filter((t) => t !== tag);
    setCustomTags(nextTags);
    await persistSettings({ ...settings, customTags: nextTags, customMoods });
  };

  const handleAddCustomMood = async () => {
    const name = newMoodNameInput.trim();
    const emoji = newMoodEmojiInput.trim();
    const existingNames = PREDEFINED_MOODS.map((m) => m.name.toLowerCase());
    if (
      name &&
      emoji &&
      !existingNames.includes(name.toLowerCase()) &&
      !customMoods.some((m) => m.name.toLowerCase() === name.toLowerCase())
    ) {
      const nextMoods = [...customMoods, { name, emoji }];
      setCustomMoods(nextMoods);
      await persistSettings({ ...settings, customTags, customMoods: nextMoods });
    }
    setNewMoodNameInput('');
    setNewMoodEmojiInput('');
  };

  const handleRemoveCustomMood = async (moodName: string) => {
    const nextMoods = customMoods.filter((m) => m.name !== moodName);
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
        isBiometricsSimulated: undefined,
      };
      await persistSecurity(newConfig);
      onShowToast?.('Biometric security disabled.', 'info');
      return;
    }

    setIsWebAuthnLoading(true);
    try {
      const result = await secureAuthService.enroll(
        syncAccountState?.googleEmail || profile.email || 'dear.diary.user',
      );
      if (result) {
        const newConfig = {
          ...security,
          isBiometricsEnabled: true,
          passkeyCredentialId: result.credentialId,
          isBiometricsSimulated: !!result.simulated,
        };
        await persistSecurity(newConfig);
        const successText = isNativePlatform()
          ? 'Native biometric unlock enabled successfully!'
          : 'Secure WebAuthn Passkey enrolled and enabled successfully!';
        setWebAuthnSuccess(successText);
        onShowToast?.(successText, 'success');
      } else if (isNativePlatform()) {
        setWebAuthnError(
          'No enrolled fingerprint or strong biometric credential is available. Add one in Android Settings, then try again.',
        );
        onShowToast?.(
          'Add a fingerprint in Android Settings, then enable biometric unlock again.',
          'warning',
        );
      } else {
        setWebAuthnError(
          'This browser could not enroll a passkey. Please continue using your PIN.',
        );
      }
    } catch (err: any) {
      console.warn('WebAuthn registration error:', err);
      if (
        err?.name === 'NotAllowedError' ||
        err?.name === 'SecurityError' ||
        err?.message?.includes('secure context') ||
        err?.message?.includes('not supported')
      ) {
        setWebAuthnError(
          `Device/Browser restriction: standard Passkeys require HTTPS and direct tab access (cannot be created inside framed environments). You can enable a Simulated Passkey for previewing.`,
        );
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
      isBiometricsSimulated: true,
    };
    await persistSecurity(newConfig);
    setWebAuthnSuccess('Simulated device biometric unlock enabled successfully!');
    setShowSimulateFallback(false);
    setWebAuthnError('');
    onShowToast?.('Simulated biometric unlock enabled.', 'success');
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    const defaultProfile = createDefaultUserProfile(syncAccountState?.googleEmail || null);
    const updatedProfile: UserProfile = {
      ...profile,
      name: profileName.trim() || defaultProfile.name,
      email: profileEmail.trim() || defaultProfile.email,
      bio: profileBio.trim(),
      avatarEmoji: profileEmoji,
      avatarColor: profileColor,
      avatarUri: profileAvatarUri,
      writingGoal: profileWritingGoal,
    };
    await diaryRepository.saveUserProfile(updatedProfile);
    setProfile(updatedProfile);
    await onDataChanged();
    if (onShowToast) {
      onShowToast('User Profile saved successfully!', 'success');
    }
  };

  const handleAvatarFile = (file?: File): void => {
    if (!file) return;
    setAvatarError('');
    if (!isSupportedImageMimeType(file.type)) {
      setAvatarError('Choose a JPEG, PNG, WebP, or BMP image.');
      if (avatarInputRef.current) avatarInputRef.current.value = '';
      return;
    }
    setPendingAvatarFile(file);
    if (avatarInputRef.current) avatarInputRef.current.value = '';
  };

  const handleAvatarSelection = async (image: Blob): Promise<void> => {
    setIsSavingAvatar(true);
    setAvatarError('');
    try {
      setProfileAvatarUri(await persistOptimizedImageFile(image, 'avatar'));
      setPendingAvatarFile(null);
    } catch (error: any) {
      setAvatarError(error?.message || 'Profile photo could not be saved.');
    } finally {
      setIsSavingAvatar(false);
    }
  };

  const handleReminderToggle = async (enabled: boolean) => {
    if (enabled) {
      const granted = await requestReminderPermission().catch(() => false);
      const capability = await getReminderCapability();
      setReminderCapability(capability);
      if (!granted) {
        await persistSettings({ ...settings, remindersEnabled: false, reminderTime });
        onShowToast?.(
          'Notification permission was not granted. Daily reminder remains off.',
          'warning',
        );
        return;
      }
    }
    const updated: AppSettings = {
      ...settings,
      remindersEnabled: enabled,
      reminderTime,
    };
    await persistSettings(updated);
    onShowToast?.(
      enabled ? 'Daily writing reminder scheduled.' : 'Daily writing reminder disabled.',
      'success',
    );
  };

  const handleReminderTimeChange = async (timeStr: string) => {
    setReminderTime(timeStr);
    const updated: AppSettings = {
      ...settings,
      reminderTime: timeStr,
    };
    await persistSettings(updated);
    if (updated.remindersEnabled) onShowToast?.(`Daily reminder moved to ${timeStr}.`, 'success');
  };

  const handleResetDatabase = async () => {
    setIsResettingContent(true);
    setResetContentError('');
    try {
      const syncConfigured = Boolean(await diaryRepository.getLocalSyncAccountState());
      await diaryRepository.resetContent();
      let syncPending = false;
      if (syncConfigured) {
        try {
          await eventSyncEngine.flushPendingOutbox();
          syncPending = (await diaryRepository.getSyncStatusSummary()).pendingOutboxCount > 0;
        } catch (error) {
          syncPending = true;
          console.warn('Account-wide content reset will retry syncing:', error);
        }
      }
      await pruneOrphanedMedia(0).catch((error) =>
        console.warn('Media cleanup will retry later:', error),
      );
      await onResetSuccess();
      setShowConfirmReset(false);
      onShowToast?.(
        syncPending
          ? 'Your saved content was deleted here. Other devices will update when sync reconnects.'
          : syncConfigured
            ? 'Your saved content was deleted from this account and synced devices.'
            : 'Your saved content was deleted from this device.',
        syncPending ? 'warning' : 'success',
      );
    } catch (error) {
      const message = syncAuthorizationMessage(
        error,
        'Could not delete your saved content. Connect to the internet and try again.',
      );
      setResetContentError(message);
      onShowToast?.(message, 'error');
    } finally {
      setIsResettingContent(false);
    }
  };

  const handleUnlinkThisBrowser = async () => {
    setIsUnlinking(true);
    setAuthError('');
    try {
      await syncV2Application.unlinkThisCompanion();
    } catch (error: any) {
      setAuthError(error?.message || 'Could not unlink this browser.');
      setIsUnlinking(false);
      setShowConfirmUnlink(false);
    }
  };

  const currentSection =
    SETTINGS_SECTIONS.find((section) => section.id === selectedSection) || SETTINGS_SECTIONS[0];
  const handleSettingsBack = () => {
    if (!hasSidebar && mobileSectionOpen) {
      setMobileSectionOpen(false);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    onBack();
  };

  return (
    <div
      className={`${hasSidebar ? 'mx-auto grid w-full max-w-6xl grid-cols-[220px_minmax(0,880px)] items-start justify-center gap-8' : 'open-page-settings flex flex-col gap-4'} pb-8 font-sans`}
    >
      <header
        className={`${hasSidebar ? 'col-span-full border-none bg-transparent py-0' : 'open-page-settings-header sticky top-0 -mx-4 border-b border-brand-rose-light/40 bg-brand-bg/95 px-4 py-3'} z-30 flex items-center justify-between backdrop-blur-md`}
      >
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleSettingsBack}
            className={`${hasSidebar ? 'hidden' : 'flex h-11 w-11 items-center justify-center'} rounded-full text-brand-plum transition-colors hover:bg-brand-blush-light focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-sage`}
            aria-label={mobileSectionOpen ? 'Back to settings' : 'Back'}
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            {!hasSidebar && !mobileSectionOpen && (
              <p className="open-page-eyebrow">Your sanctuary</p>
            )}
            <h1
              className={`${hasSidebar ? 'text-4xl font-semibold' : 'text-xl font-bold'} tracking-[-0.025em] text-brand-plum dark:text-brand-text`}
            >
              {!hasSidebar && mobileSectionOpen ? currentSection.label : 'Settings'}
            </h1>
            {!hasSidebar && !mobileSectionOpen && (
              <p className="open-page-settings-summary">
                Privacy, writing, and device preferences.
              </p>
            )}
            {hasSidebar && (
              <p className="mt-2 text-lg text-brand-text-muted">
                Manage your digital sanctuary and privacy preferences.
              </p>
            )}
          </div>
        </div>
      </header>

      <nav
        aria-label="Settings sections"
        className={`${hasSidebar ? 'sticky top-6 border-r border-brand-border/70 pr-3' : mobileSectionOpen ? 'hidden' : 'open-page-settings-nav overflow-hidden border-y border-brand-border bg-transparent'}`}
      >
        {SETTINGS_SECTIONS.map((section) => {
          const Icon = section.icon;
          const isActive = selectedSection === section.id;
          return (
            <button
              key={section.id}
              type="button"
              onClick={() => openSection(section.id)}
              aria-current={hasSidebar && isActive ? 'page' : undefined}
              className={`${hasSidebar ? 'mb-1 rounded-2xl px-3 py-3' : 'min-h-14 border-b border-brand-border/60 px-4 py-2 last:border-b-0'} group flex w-full items-center gap-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-sage ${hasSidebar && isActive ? 'bg-brand-sage text-white' : 'text-brand-plum hover:bg-brand-blush-light/60 dark:text-brand-text dark:hover:bg-white/5'}`}
            >
              <span
                className={`${hasSidebar && isActive ? 'bg-white/15 text-[var(--color-on-primary)]' : 'bg-brand-sage/10 text-brand-sage'} flex h-10 w-10 shrink-0 items-center justify-center rounded-xl`}
              >
                <Icon className="h-5 w-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-bold">{section.label}</span>
                {!hasSidebar && (
                  <span className="open-page-settings-description mt-0.5 block text-xs text-brand-text-muted">
                    {section.description}
                  </span>
                )}
              </span>
              {!hasSidebar && (
                <ChevronRight
                  className="h-5 w-5 shrink-0 text-brand-text-muted"
                  aria-hidden="true"
                />
              )}
            </button>
          );
        })}
      </nav>

      {/* Security Config settings */}
      {(hasSidebar || mobileSectionOpen) && (
        <div className="open-page-settings-content min-w-0 flex flex-col gap-5">
          <div className="hidden sm:block">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-brand-sage">
              Settings
            </p>
            <h2 className="mt-1 text-3xl font-semibold tracking-[-0.025em] text-brand-plum dark:text-brand-text">
              {currentSection.label}
            </h2>
            <p className="mt-1 text-sm text-brand-text-muted">{currentSection.description}</p>
          </div>
          <AnimatePresence mode="wait">
            {selectedSection === 'profile' && (
              <motion.div
                key="profile"
                {...pageMotion(prefersReducedMotion)}
                className="flex flex-col gap-5"
              >
                {/* User Profile Customizer Card */}
                <div className="bg-brand-card-bg p-6 rounded-3xl journal-shadow border border-brand-border flex flex-col gap-5">
                  <div className="flex items-center gap-3">
                    <span className="p-2.5 bg-brand-blush-light dark:bg-brand-blush-light/10 text-brand-pink rounded-2xl">
                      <User className="w-4 h-4" />
                    </span>
                    <div>
                      <h3 className="text-sm font-bold text-brand-plum dark:text-brand-text">
                        My User Profile
                      </h3>
                      <p className="text-xs text-brand-sage mt-0.5">
                        Personalize your welcoming details and daily targets
                      </p>
                    </div>
                  </div>

                  <form onSubmit={handleSaveProfile} className="flex flex-col gap-4">
                    {/* Compact preview; customization opens as a focused secondary task. */}
                    <button
                      type="button"
                      onClick={() => setShowAvatarEditor(true)}
                      className="flex min-h-20 w-full items-center gap-4 border-y border-brand-border/60 py-3 text-left"
                    >
                      <span
                        className="relative flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-full border border-brand-border text-3xl"
                        style={{ backgroundColor: profileColor }}
                      >
                        <ProfileAvatar
                          profile={{
                            ...profile,
                            name: profileName,
                            avatarEmoji: profileEmoji,
                            avatarColor: profileColor,
                            avatarUri: profileAvatarUri,
                          }}
                        />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-bold text-brand-plum dark:text-brand-text">
                          Profile image
                        </span>
                        <span className="mt-1 block text-xs text-brand-text-muted">
                          Choose a photo or a personal emblem
                        </span>
                      </span>
                      <ChevronRight className="h-5 w-5 text-brand-text-muted" />
                    </button>

                    {/* Fields */}
                    <div className="flex flex-col gap-3">
                      <div>
                        <label className="text-xs text-brand-sage font-bold uppercase tracking-wider block mb-1">
                          Your Nickname
                        </label>
                        <div className="relative flex items-center">
                          <User className="w-4 h-4 text-brand-sage absolute left-3.5 pointer-events-none" />
                          <input
                            type="text"
                            value={profileName}
                            onChange={(e) => setProfileName(e.target.value)}
                            placeholder={profile.name || 'Your nickname'}
                            className="w-full bg-brand-bg border border-brand-border py-2.5 pl-10 pr-4 rounded-xl text-xs text-brand-plum dark:text-brand-text focus:outline-none focus:border-brand-pink"
                            required
                          />
                        </div>
                      </div>

                      <div>
                        <label className="text-xs text-brand-sage font-bold uppercase tracking-wider block mb-1">
                          Profile email (display only)
                        </label>
                        <div className="relative flex items-center">
                          <Mail className="w-4 h-4 text-brand-sage absolute left-3.5 pointer-events-none" />
                          <input
                            type="email"
                            value={profileEmail}
                            readOnly
                            aria-readonly="true"
                            tabIndex={-1}
                            placeholder={syncAccountState?.googleEmail || 'Email address'}
                            className="w-full cursor-default bg-brand-bg/60 border border-brand-border py-2.5 pl-10 pr-4 rounded-xl text-xs text-brand-text-muted focus:outline-none"
                            required
                          />
                        </div>
                      </div>

                      <div>
                        <label className="text-xs text-brand-sage font-bold uppercase tracking-wider block mb-1">
                          Daily Mantra / Bio
                        </label>
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
                          <label
                            htmlFor="daily-writing-target"
                            className="text-xs text-brand-sage font-bold uppercase tracking-wider"
                          >
                            Daily Writing Target
                          </label>
                          <span className="font-mono text-xs text-brand-pink font-bold">
                            {profileWritingGoal} words
                          </span>
                        </div>
                        <input
                          id="daily-writing-target"
                          type="range"
                          min="50"
                          max="1000"
                          step="50"
                          value={profileWritingGoal}
                          onChange={(e) => setProfileWritingGoal(Number(e.target.value))}
                          className="w-full accent-brand-pink h-1.5 bg-brand-bg rounded-lg appearance-none cursor-pointer border border-brand-border"
                        />
                        <div className="flex justify-between text-xs text-brand-sage font-bold mt-1">
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
                  <div className="flex justify-between items-center text-xs text-brand-sage font-semibold border-t border-brand-border/40 pt-3">
                    <span>Your Story Began</span>
                    <span className="text-brand-plum dark:text-brand-text font-bold uppercase tracking-wider">
                      {profile.joinedDate || 'June 2026'}
                    </span>
                  </div>
                </div>
              </motion.div>
            )}

            {selectedSection === 'about' && (
              <motion.div
                key="about"
                {...pageMotion(prefersReducedMotion)}
                className="flex flex-col gap-5"
              >
                <div className="rounded-3xl border border-brand-border bg-brand-card-bg p-6 journal-shadow">
                  <div className="flex items-center gap-3">
                    <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-brand-sage/10 text-brand-sage">
                      <Info className="h-5 w-5" />
                    </span>
                    <div>
                      <h3 className="text-xl font-semibold text-brand-plum dark:text-brand-text">
                        {BRAND.name}
                      </h3>
                      <p className="text-sm text-brand-text-muted">{BRAND.tagline}</p>
                    </div>
                  </div>
                  <div className="mt-5 space-y-3 text-sm leading-6 text-brand-text-muted">
                    <p>
                      Your writing is encrypted on this device. Optional encrypted sync keeps your
                      account and recovery controls separate from your public profile.
                    </p>
                    <p>
                      {BRAND.name} does not use your entries for advertising. On-device suggestions
                      are identified wherever they appear.
                    </p>
                  </div>
                  <dl className="mt-6 grid gap-3 border-t border-brand-border pt-5 text-sm sm:grid-cols-2">
                    <div>
                      <dt className="text-brand-text-muted">Version</dt>
                      <dd className="mt-1 font-bold text-brand-plum dark:text-brand-text">
                        {import.meta.env.VITE_APP_VERSION || '1.0.0'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-brand-text-muted">Storage model</dt>
                      <dd className="mt-1 font-bold text-brand-plum dark:text-brand-text">
                        Local-first, encrypted
                      </dd>
                    </div>
                  </dl>
                  <button
                    type="button"
                    onClick={exportSyncDiagnostics}
                    disabled={!syncHealth}
                    className="mt-5 min-h-11 w-full rounded-xl border border-brand-border px-4 text-sm font-bold text-brand-sage disabled:opacity-40"
                  >
                    Download support information
                  </button>
                </div>
              </motion.div>
            )}

            {selectedSection === 'privacy-security' && (
              <motion.div
                key="security"
                {...pageMotion(prefersReducedMotion)}
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
                        <h3 className="text-sm font-bold text-brand-plum">
                          Update App Security PIN
                        </h3>
                        <p className="text-xs text-brand-sage mt-0.5">
                          Change your 4-digit or 8-digit passcode
                        </p>
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
                    <form
                      onSubmit={handlePinChangeSubmit}
                      className="mt-3 pt-3 border-t border-brand-border flex flex-col gap-3"
                    >
                      <div className="flex flex-col gap-1">
                        <span className="text-xs font-bold text-brand-sage uppercase tracking-wider">
                          New PIN Length
                        </span>
                        <div className="grid grid-cols-2 gap-2 bg-brand-bg/70 border border-brand-border rounded-xl p-1">
                          {([4, 8] as PinLength[]).map((length) => (
                            <button
                              key={length}
                              type="button"
                              onClick={() => {
                                setNewPinLength(length);
                                setNewPin('');
                                setConfirmPin('');
                                setPinError('');
                              }}
                              className={`py-2 rounded-lg text-xs font-black uppercase tracking-wider transition-all ${
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
                          <span className="text-xs font-bold text-brand-sage uppercase tracking-wider">
                            Current PIN
                          </span>
                          <input
                            type="password"
                            inputMode="numeric"
                            maxLength={security.pinLength || 8}
                            value={currentPin}
                            onChange={(e) =>
                              setCurrentPin(
                                e.target.value.replace(/\D/g, '').slice(0, security.pinLength || 8),
                              )
                            }
                            placeholder="Current"
                            className="bg-brand-bg text-sm text-brand-plum border border-brand-border p-2.5 rounded-xl focus:outline-none"
                          />
                        </div>
                        <div className="flex flex-col gap-1">
                          <span className="text-xs font-bold text-brand-sage uppercase tracking-wider">
                            New PIN
                          </span>
                          <input
                            type="password"
                            inputMode="numeric"
                            maxLength={newPinLength}
                            value={newPin}
                            onChange={(e) =>
                              setNewPin(e.target.value.replace(/\D/g, '').slice(0, newPinLength))
                            }
                            placeholder={`${newPinLength} digits`}
                            className="bg-brand-bg text-sm text-brand-plum border border-brand-border p-2.5 rounded-xl focus:outline-none"
                          />
                        </div>
                        <div className="flex flex-col gap-1">
                          <span className="text-xs font-bold text-brand-sage uppercase tracking-wider">
                            Confirm PIN
                          </span>
                          <input
                            type="password"
                            inputMode="numeric"
                            maxLength={newPinLength}
                            value={confirmPin}
                            onChange={(e) =>
                              setConfirmPin(
                                e.target.value.replace(/\D/g, '').slice(0, newPinLength),
                              )
                            }
                            placeholder="Confirm digits"
                            className="bg-brand-bg text-sm text-brand-plum border border-brand-border p-2.5 rounded-xl focus:outline-none"
                          />
                        </div>
                      </div>

                      {pinError && (
                        <p className="text-xs font-bold text-brand-pink-dark text-center">
                          {pinError}
                        </p>
                      )}
                      {pinSuccess && (
                        <p className="text-xs font-bold text-brand-sage text-center flex items-center justify-center gap-1">
                          <Check className="w-4 h-4" /> Security PIN updated successfully!
                        </p>
                      )}

                      <button
                        type="submit"
                        disabled={
                          !isValidPin(currentPin, security.pinLength) ||
                          !isValidPin(newPin, newPinLength) ||
                          newPin !== confirmPin
                        }
                        className="w-full py-2 bg-brand-sage hover:bg-brand-sage-dark disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold text-xs rounded-xl shadow-sm transition-colors"
                      >
                        Save Security Code
                      </button>
                    </form>
                  )}
                </div>

                {syncAccountState?.deviceRole === 'primary_mobile' && (
                  <div className="bg-brand-card-bg p-5 rounded-3xl journal-shadow border border-brand-border flex flex-col gap-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-3">
                        <span className="p-2.5 bg-brand-sage/10 text-brand-sage rounded-2xl">
                          <RefreshCw className="w-4 h-4" />
                        </span>
                        <div className="min-w-0">
                          <h3 className="text-sm font-bold text-brand-plum">
                            Account Recovery Passphrase
                          </h3>
                          <p className="text-xs text-brand-sage mt-0.5 truncate">
                            {syncAccountState.googleEmail}
                          </p>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setShowSyncRecoveryForm((value) => !value);
                          setSyncRecoveryError('');
                        }}
                        className="shrink-0 px-4 py-2 bg-brand-bg hover:bg-brand-rose-light text-xs font-bold text-brand-sage-dark rounded-full border border-brand-border transition-colors"
                      >
                        {showSyncRecoveryForm ? 'Close' : 'Change'}
                      </button>
                    </div>

                    {showSyncRecoveryForm && (
                      <form
                        onSubmit={handleRotateRecoveryPassphrase}
                        className="mt-2 pt-3 border-t border-brand-border flex flex-col gap-3"
                      >
                        <label className="flex flex-col gap-1">
                          <span className="text-xs font-bold text-brand-sage uppercase tracking-wider">
                            New 8-Digit Passphrase
                          </span>
                          <input
                            type="password"
                            inputMode="numeric"
                            autoComplete="new-password"
                            maxLength={RECOVERY_PASSPHRASE_DIGIT_LENGTH}
                            value={newRecoveryPassphrase}
                            onChange={(event) =>
                              setNewRecoveryPassphrase(
                                event.target.value
                                  .replace(/\D/g, '')
                                  .slice(0, RECOVERY_PASSPHRASE_DIGIT_LENGTH),
                              )
                            }
                            className="bg-brand-bg text-sm text-brand-plum border border-brand-border p-2.5 rounded-xl focus:outline-none focus:border-brand-pink"
                          />
                        </label>
                        <label className="flex flex-col gap-1">
                          <span className="text-xs font-bold text-brand-sage uppercase tracking-wider">
                            Confirm 8-Digit Passphrase
                          </span>
                          <input
                            type="password"
                            inputMode="numeric"
                            autoComplete="new-password"
                            maxLength={RECOVERY_PASSPHRASE_DIGIT_LENGTH}
                            value={confirmNewRecoveryPassphrase}
                            onChange={(event) =>
                              setConfirmNewRecoveryPassphrase(
                                event.target.value
                                  .replace(/\D/g, '')
                                  .slice(0, RECOVERY_PASSPHRASE_DIGIT_LENGTH),
                              )
                            }
                            className="bg-brand-bg text-sm text-brand-plum border border-brand-border p-2.5 rounded-xl focus:outline-none focus:border-brand-pink"
                          />
                        </label>
                        {syncRecoveryError && (
                          <p className="text-xs font-bold text-brand-pink-dark">
                            {syncRecoveryError}
                          </p>
                        )}
                        <button
                          type="submit"
                          disabled={
                            isRotatingRecoveryPassphrase ||
                            !isValidNewRecoveryPassphrase(newRecoveryPassphrase) ||
                            newRecoveryPassphrase !== confirmNewRecoveryPassphrase
                          }
                          className="w-full py-2 bg-brand-sage hover:bg-brand-sage-dark disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold text-xs rounded-xl shadow-sm transition-colors"
                        >
                          {isRotatingRecoveryPassphrase
                            ? 'Changing...'
                            : 'Change Recovery Passphrase'}
                        </button>
                      </form>
                    )}
                  </div>
                )}

                {isNativePlatform() && (
                  <>
                    {/* Passkey & Biometric settings card */}
                    <div className="bg-brand-card-bg p-5 rounded-3xl journal-shadow border border-brand-border flex flex-col gap-4">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <span className="p-2.5 bg-brand-blush-light dark:bg-brand-blush-light/10 text-brand-pink rounded-2xl">
                            <Fingerprint className="w-4 h-4 text-brand-pink" />
                          </span>
                          <div>
                            <h3 className="text-sm font-bold text-brand-plum">
                              Passkey & Biometrics
                            </h3>
                            <p className="text-xs text-brand-sage mt-0.5">
                              Secure your entries with device authenticators
                            </p>
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
                          <p className="text-xs text-brand-sage animate-pulse">
                            {isNativePlatform()
                              ? 'Confirm the Android biometric prompt to enable fingerprint unlock...'
                              : 'Please follow your browser prompt to register your device passkey...'}
                          </p>
                        )}

                        {webAuthnSuccess && (
                          <div className="p-2.5 bg-brand-sage/5 border border-brand-sage/20 text-brand-sage-dark rounded-xl font-medium">
                            {webAuthnSuccess}
                            {security.isBiometricsSimulated && (
                              <span className="block text-xs mt-1 font-bold text-brand-sage-dark/70 uppercase tracking-wider">
                                ⚡ Running in Preview Sandbox Simulation
                              </span>
                            )}
                          </div>
                        )}

                        {webAuthnError && (
                          <div className="p-2.5 bg-brand-pink/5 border border-brand-pink/20 text-brand-pink-dark rounded-xl text-xs font-medium leading-normal space-y-2">
                            <p>{webAuthnError}</p>
                            {showSimulateFallback && (
                              <button
                                type="button"
                                onClick={handleEnableSimulatedBiometrics}
                                className="w-full py-1.5 bg-brand-pink hover:bg-brand-pink-dark text-white rounded-lg font-bold text-xs uppercase tracking-wider transition-all"
                              >
                                Use Simulated Passkey (for Preview)
                              </button>
                            )}
                          </div>
                        )}

                        {security.isBiometricsEnabled ? (
                          <div className="p-2 bg-brand-bg/50 dark:bg-brand-bg/10 rounded-xl text-xs text-brand-sage flex items-center gap-1.5 border border-brand-border/30">
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
                          <p className="text-xs text-brand-sage">
                            {isNativePlatform()
                              ? 'Enable after adding a fingerprint or strong biometric in Android Settings. PIN remains your primary backup and is removed by Android Clear storage.'
                              : "Enrolling triggers your browser's native credential manager (Windows Hello, Face ID, or Touch ID). PIN is required as your primary backup."}
                          </p>
                        )}
                      </div>
                    </div>
                  </>
                )}
              </motion.div>
            )}

            {selectedSection === 'sync-backup' && (
              <motion.div
                key="sync-backup"
                {...pageMotion(prefersReducedMotion)}
                className="flex flex-col gap-5"
              >
                <div className="rounded-3xl border border-brand-border bg-brand-card-bg p-5 journal-shadow">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-brand-sage/10 text-brand-sage">
                        <Cloud className="h-5 w-5" />
                      </span>
                      <div className="min-w-0">
                        <h3 className="text-sm font-bold text-brand-plum dark:text-brand-text">
                          Connected Google identity
                        </h3>
                        <p className="mt-1 truncate text-sm text-brand-text-muted">
                          {syncAccountState?.googleEmail ||
                            security.linkedGoogleEmail ||
                            'Not connected'}
                        </p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void reconnectSyncAccount()}
                      disabled={isAuthLoading || !syncAccountState}
                      className="flex h-11 min-w-11 shrink-0 items-center justify-center rounded-xl border border-brand-border px-3 text-sm font-bold text-brand-sage disabled:opacity-40"
                    >
                      {isAuthLoading ? 'Connecting…' : 'Reconnect'}
                    </button>
                  </div>
                  {authError && (
                    <p className="mt-3 rounded-xl bg-red-50 p-3 text-sm font-semibold text-red-700 dark:bg-red-950/20 dark:text-red-300">
                      {authError}
                    </p>
                  )}
                </div>

                <div className="rounded-3xl border border-brand-border bg-brand-card-bg p-5 journal-shadow">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h3 className="text-sm font-bold text-brand-plum dark:text-brand-text">
                        Sync health
                      </h3>
                      <p className="mt-1 text-sm text-brand-text-muted">
                        {syncHealth
                          ? getSyncHealthStatusMessage(syncHealth)
                          : syncAccountState
                            ? 'Checking encrypted sync…'
                            : 'Connect an account to enable encrypted sync.'}
                      </p>
                    </div>
                    <span
                      className={`${failedSyncCount > 0 ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300' : 'bg-brand-sage/10 text-brand-sage'} rounded-full px-3 py-1.5 text-xs font-bold`}
                    >
                      {failedSyncCount > 0
                        ? 'Needs attention'
                        : pendingSyncCount > 0
                          ? 'Syncing'
                          : syncAccountState
                            ? 'Healthy'
                            : 'Not connected'}
                    </span>
                  </div>
                  <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                    <div className="rounded-2xl bg-brand-bg/50 p-3">
                      <dt className="text-brand-text-muted">Last sync</dt>
                      <dd className="mt-1 font-bold text-brand-plum dark:text-brand-text">
                        {formatDateTime(syncHealth?.lastSuccessfulPullAt)}
                      </dd>
                    </div>
                    <div className="rounded-2xl bg-brand-bg/50 p-3">
                      <dt className="text-brand-text-muted">Recovery</dt>
                      <dd className="mt-1 font-bold text-brand-plum dark:text-brand-text">
                        {syncAccountState ? 'Passphrase configured' : 'Not configured'}
                      </dd>
                    </div>
                  </dl>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void retryLocalSync()}
                      disabled={!syncAccountState || isRetryingSync}
                      className="min-h-11 rounded-xl bg-brand-sage px-4 text-sm font-bold text-white disabled:opacity-40"
                    >
                      {isRetryingSync ? 'Syncing…' : 'Sync Now'}
                    </button>
                  </div>
                  {syncStatusError && (
                    <p className="mt-3 rounded-xl bg-amber-50 p-3 text-sm font-semibold text-amber-800 dark:bg-amber-950/20 dark:text-amber-300">
                      {syncStatusError}
                    </p>
                  )}
                </div>

                {preservedConflicts.length > 0 && (
                  <div className="rounded-3xl border border-amber-200 bg-amber-50/80 p-5 dark:border-amber-900/50 dark:bg-amber-950/20">
                    <h3 className="text-sm font-bold text-amber-800 dark:text-amber-300">
                      Sync issues to review
                    </h3>
                    <p className="mt-1 text-sm text-brand-text-muted">
                      Choose which version to keep for each conflicting edit.
                    </p>
                    <div className="mt-4 space-y-3">
                      {preservedConflicts.map((conflict) => {
                        const isBusy = conflictActionId === conflict.operation.operationId;
                        return (
                          <div
                            key={conflict.operation.operationId}
                            className="rounded-2xl border border-amber-200 bg-white/60 p-3 dark:bg-black/10"
                          >
                            <p className="text-xs font-bold uppercase tracking-wider text-amber-800 dark:text-amber-300">
                              {conflict.operation.recordType} edit conflict
                            </p>
                            <div className="mt-3 flex flex-wrap gap-2">
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() =>
                                  void runConflictAction(
                                    conflict.operation.operationId,
                                    () =>
                                      diaryRepository.resolvePreservedSyncConflict(
                                        conflict.operation.operationId,
                                        'keep-recovered',
                                      ),
                                    'Edit from this device queued to sync.',
                                  )
                                }
                                className="rounded-full bg-brand-sage px-3 py-2 text-xs font-bold text-white disabled:opacity-45"
                              >
                                Use edit from this device
                              </button>
                              {conflict.operation.recoveredRecordId && (
                                <button
                                  type="button"
                                  disabled={isBusy}
                                  onClick={() =>
                                    void runConflictAction(
                                      conflict.operation.operationId,
                                      () =>
                                        diaryRepository.resolvePreservedSyncConflict(
                                          conflict.operation.operationId,
                                          'keep-current',
                                        ),
                                      'Synced version kept.',
                                    )
                                  }
                                  className="rounded-full border border-brand-border px-3 py-2 text-xs font-bold text-brand-plum disabled:opacity-45"
                                >
                                  Use synced version
                                </button>
                              )}
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() =>
                                  void runConflictAction(
                                    conflict.operation.operationId,
                                    () =>
                                      diaryRepository.resolvePreservedSyncConflict(
                                        conflict.operation.operationId,
                                        'keep-both',
                                      ),
                                    'Both copies kept.',
                                  )
                                }
                                className="rounded-full border border-brand-border px-3 py-2 text-xs font-bold text-brand-sage disabled:opacity-45"
                              >
                                Keep both copies
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                <CompanionApprovalPanel />

                {syncAccountState?.deviceRole === 'web_companion' && (
                  <div className="rounded-3xl border border-red-200 bg-red-50/70 p-5 dark:border-red-900/40 dark:bg-red-950/10">
                    <h3 className="text-sm font-bold text-red-700 dark:text-red-300">
                      Unlink this browser
                    </h3>
                    <p className="mt-2 text-sm leading-relaxed text-red-600 dark:text-red-400">
                      Stops sync, revokes this browser, and permanently clears its local encrypted
                      saved content and keys. Your other devices are unaffected.
                    </p>
                    {!showConfirmUnlink ? (
                      <button
                        type="button"
                        onClick={() => setShowConfirmUnlink(true)}
                        className="mt-4 min-h-11 rounded-xl border border-red-300 px-4 text-sm font-bold text-red-700"
                      >
                        Unlink this browser
                      </button>
                    ) : (
                      <div className="mt-4 grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() => setShowConfirmUnlink(false)}
                          disabled={isUnlinking}
                          className="min-h-11 rounded-xl border border-brand-border text-sm font-bold text-brand-sage disabled:opacity-40"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleUnlinkThisBrowser()}
                          disabled={isUnlinking}
                          className="min-h-11 rounded-xl bg-red-600 text-sm font-bold text-white disabled:opacity-40"
                        >
                          {isUnlinking ? 'Unlinking…' : 'Confirm unlink'}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </motion.div>
            )}

            {selectedSection === 'data-storage' && (
              <motion.div
                key="data-storage"
                {...pageMotion(prefersReducedMotion)}
                className="flex flex-col gap-5"
              >
                <div className="rounded-3xl border border-brand-border bg-brand-card-bg p-5 journal-shadow">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-bold text-brand-plum dark:text-brand-text">
                        On this device
                      </h3>
                      <p className="mt-1 text-sm text-brand-text-muted">Available offline</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void refreshLocalStorageUsage()}
                      disabled={isLocalStorageUsageLoading}
                      className="flex h-11 min-w-11 items-center justify-center rounded-xl border border-brand-border text-brand-sage disabled:opacity-40"
                      aria-label="Refresh on-device storage usage"
                    >
                      <RefreshCw
                        className={`h-4 w-4 ${isLocalStorageUsageLoading ? 'animate-spin' : ''}`}
                      />
                    </button>
                  </div>
                  <p className="mt-4 text-2xl font-semibold text-brand-plum dark:text-brand-text">
                    {localStorageUsage
                      ? formatBytes(localStorageUsage.totalBytes)
                      : isLocalStorageUsageLoading
                        ? 'Calculating…'
                        : 'Unavailable'}
                  </p>
                  <div className="mt-4 grid gap-2">
                    {[
                      [
                        'Writing & settings',
                        localStorageUsage?.writingBytes,
                        localStorageUsage
                          ? `${localStorageUsage.journalCount} collections · ${localStorageUsage.entryCount} entries · ${localStorageUsage.noteCount} notes`
                          : '',
                      ],
                      [
                        'Photos',
                        localStorageUsage?.imageBytes,
                        localStorageUsage ? `${localStorageUsage.imageCount} saved locally` : '',
                      ],
                      [
                        'Voice notes',
                        localStorageUsage?.audioBytes,
                        localStorageUsage ? `${localStorageUsage.audioCount} saved locally` : '',
                      ],
                    ].map(([label, bytes, detail]) => (
                      <div
                        key={String(label)}
                        className="flex items-center justify-between gap-3 rounded-xl bg-brand-bg/50 p-3 text-sm"
                      >
                        <span className="min-w-0">
                          <span className="block font-semibold text-brand-plum dark:text-brand-text">
                            {label}
                          </span>
                          {detail && (
                            <span className="mt-0.5 block truncate text-xs text-brand-text-muted">
                              {detail}
                            </span>
                          )}
                        </span>
                        <span className="shrink-0 font-bold text-brand-sage">
                          {typeof bytes === 'number' ? formatBytes(bytes) : '—'}
                        </span>
                      </div>
                    ))}
                  </div>
                  {localStorageUsageError && (
                    <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-300">
                      {localStorageUsageError}
                    </p>
                  )}
                </div>
                <div className="rounded-3xl border border-red-200 bg-red-50/70 p-5 dark:border-red-900/40 dark:bg-red-950/10">
                  <h3 className="text-sm font-bold text-red-700 dark:text-red-300">
                    Delete all saved content
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-red-600 dark:text-red-400">
                    Permanently deletes collections, entries, notes, and attached media from this
                    account. The deletion syncs to every linked device. Your profile, security
                    settings, and device links remain.
                  </p>
                  {!showConfirmReset ? (
                    <button
                      type="button"
                      onClick={() => {
                        setResetContentError('');
                        setShowConfirmReset(true);
                      }}
                      className="mt-4 min-h-11 rounded-xl border border-red-300 px-4 text-sm font-bold text-red-700"
                    >
                      Review clear action
                    </button>
                  ) : (
                    <div className="mt-4 rounded-2xl border border-red-300 bg-white/60 p-3 dark:bg-black/10">
                      <p className="text-sm font-bold text-red-700 dark:text-red-300">
                        This cannot be undone. Linked devices will delete this content when they
                        next sync.
                      </p>
                      <div className="mt-3 grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() => setShowConfirmReset(false)}
                          disabled={isResettingContent}
                          className="min-h-11 rounded-xl border border-brand-border text-sm font-bold text-brand-sage"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleResetDatabase()}
                          disabled={isResettingContent}
                          className="min-h-11 rounded-xl bg-red-600 text-sm font-bold text-white"
                        >
                          {isResettingContent ? 'Deleting everywhere...' : 'Delete everywhere'}
                        </button>
                      </div>
                      {resetContentError && (
                        <p
                          className="mt-3 text-sm font-medium text-red-700 dark:text-red-300"
                          role="alert"
                        >
                          {resetContentError}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </motion.div>
            )}

            {(selectedSection === 'appearance' ||
              selectedSection === 'writing' ||
              selectedSection === 'notifications') && (
              <motion.div
                key={selectedSection}
                {...pageMotion(prefersReducedMotion)}
                className="flex flex-col gap-5"
              >
                {selectedSection === 'notifications' && (
                  <div className="bg-brand-card-bg p-5 rounded-3xl journal-shadow border border-brand-border flex flex-col gap-4">
                    <div className="flex items-center justify-between gap-4">
                      <div className="flex items-center gap-3">
                        <span className="p-2.5 bg-brand-sage/10 text-brand-sage rounded-2xl">
                          <Bell className="w-4 h-4" />
                        </span>
                        <div>
                          <h3 className="text-sm font-bold text-brand-plum">
                            Daily Writing Reminder
                          </h3>
                          <p className="text-xs text-brand-sage mt-0.5">
                            {reminderCapability.supported
                              ? 'A local Android notification at your chosen time'
                              : 'Local reminders are available in the Android app'}
                          </p>
                        </div>
                      </div>
                      <label
                        className={`relative inline-flex items-center ${reminderCapability.supported ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}`}
                      >
                        <input
                          type="checkbox"
                          className="sr-only peer"
                          checked={reminderCapability.supported && settings.remindersEnabled}
                          disabled={!reminderCapability.supported}
                          onChange={(event) => void handleReminderToggle(event.target.checked)}
                        />
                        <span className="w-11 h-6 rounded-full bg-brand-border peer-checked:bg-brand-pink after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:w-5 after:h-5 after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-5" />
                      </label>
                    </div>

                    {reminderCapability.supported && (
                      <label className="flex items-center justify-between gap-3 rounded-2xl border border-brand-border/50 bg-brand-bg/40 px-4 py-3">
                        <span className="text-xs font-bold text-brand-sage uppercase tracking-wider">
                          Reminder time
                        </span>
                        <input
                          type="time"
                          value={reminderTime}
                          disabled={!settings.remindersEnabled}
                          onChange={(event) => void handleReminderTimeChange(event.target.value)}
                          className="rounded-xl border border-brand-border bg-brand-card-bg px-3 py-2 text-xs font-bold text-brand-plum disabled:opacity-50"
                        />
                      </label>
                    )}

                    {reminderCapability.permission === 'denied' && (
                      <p className="text-xs text-brand-pink-dark">
                        Notifications are blocked. Enable them in Android Settings, then try again.
                      </p>
                    )}
                  </div>
                )}

                {/* App Theme Selector */}
                {selectedSection === 'appearance' && (
                  <>
                    <div className="bg-brand-card-bg p-5 rounded-3xl journal-shadow border border-brand-border flex flex-col gap-4">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <span className="p-2.5 bg-brand-blush-light dark:bg-brand-blush-light/10 text-brand-pink rounded-2xl">
                            {settings.theme === 'dark' ? (
                              <Moon className="w-4 h-4" />
                            ) : (
                              <Sun className="w-4 h-4" />
                            )}
                          </span>
                          <div>
                            <h3 className="text-sm font-bold text-brand-plum">Application Theme</h3>
                            <p className="text-xs text-brand-sage mt-0.5">
                              Toggle between Light and Dark mode
                            </p>
                          </div>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-3">
                        <button
                          onClick={() => handleThemeChange('light')}
                          className={`flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-control)] border px-3 py-3 text-xs font-bold transition-all ${
                            settings.theme !== 'dark'
                              ? 'border-accent bg-accent text-[var(--color-on-primary)] shadow-sm'
                              : 'bg-brand-bg text-brand-sage border-brand-border hover:bg-brand-blush-light dark:hover:bg-brand-blush-light/10'
                          }`}
                        >
                          <Sun className="w-4 h-4" />
                          Light Mode
                        </button>
                        <button
                          onClick={() => handleThemeChange('dark')}
                          className={`flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-control)] border px-3 py-3 text-xs font-bold transition-all ${
                            settings.theme === 'dark'
                              ? 'border-accent bg-accent text-[var(--color-on-primary)] shadow-sm'
                              : 'bg-brand-bg text-brand-sage border-brand-border hover:bg-brand-blush-light dark:hover:bg-brand-blush-light/10'
                          }`}
                        >
                          <Moon className="w-4 h-4" />
                          Dark Mode
                        </button>
                      </div>
                    </div>

                    <AccentThemeSelector
                      value={accentTheme}
                      onChange={(value) => onAccentThemeChange?.(value)}
                    />
                  </>
                )}

                {/* Custom Tags */}
                {selectedSection === 'writing' && (
                  <>
                    <div className="bg-brand-card-bg p-5 rounded-3xl journal-shadow border border-brand-border flex flex-col gap-4">
                      <div className="flex items-center gap-3 mb-2">
                        <span className="p-2.5 bg-brand-blush-light dark:bg-brand-blush-light/10 text-brand-pink rounded-2xl">
                          <Tag className="w-4 h-4" />
                        </span>
                        <div>
                          <h3 className="text-sm font-bold text-brand-plum">Custom Tags</h3>
                          <p className="text-xs text-brand-sage mt-0.5">Add your own categories</p>
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {customTags.map((tag) => (
                          <span
                            key={tag}
                            className="flex items-center gap-1.5 px-3 py-1 bg-brand-bg border border-brand-border rounded-full text-xs font-semibold text-brand-sage-dark"
                          >
                            #{tag}
                            <button
                              type="button"
                              onClick={() => handleRemoveCustomTag(tag)}
                              className="text-brand-pink hover:text-brand-pink-dark"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </span>
                        ))}
                        {customTags.length === 0 && (
                          <p className="text-xs text-brand-sage italic">
                            No custom tags added yet.
                          </p>
                        )}
                      </div>
                      <details className="border-t border-brand-border/60 pt-3">
                        <summary className="min-h-11 cursor-pointer list-none text-sm font-bold text-brand-sage">
                          Add a custom tag
                        </summary>
                        <div className="flex gap-2 pt-2">
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
                      </details>
                    </div>

                    {/* Custom Moods */}
                    <div className="bg-brand-card-bg p-5 rounded-3xl journal-shadow border border-brand-border flex flex-col gap-4">
                      <div className="flex items-center gap-3 mb-2">
                        <span className="p-2.5 bg-brand-blush-light dark:bg-brand-blush-light/10 text-brand-pink rounded-2xl">
                          <Smile className="w-4 h-4" />
                        </span>
                        <div>
                          <h3 className="text-sm font-bold text-brand-plum">Custom Moods</h3>
                          <p className="text-xs text-brand-sage mt-0.5">
                            Add your own moods with emojis
                          </p>
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {customMoods.map((mood) => (
                          <span
                            key={mood.name}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-brand-bg border border-brand-border rounded-full text-xs font-semibold text-brand-sage-dark"
                          >
                            <span>{mood.emoji}</span>
                            <span>{mood.name}</span>
                            <button
                              type="button"
                              onClick={() => handleRemoveCustomMood(mood.name)}
                              className="text-brand-pink hover:text-brand-pink-dark ml-1"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </span>
                        ))}
                        {customMoods.length === 0 && (
                          <p className="text-xs text-brand-sage italic">
                            No custom moods added yet.
                          </p>
                        )}
                      </div>
                      <details className="border-t border-brand-border/60 pt-3">
                        <summary className="min-h-11 cursor-pointer list-none text-sm font-bold text-brand-sage">
                          Add a custom mood
                        </summary>
                        <div className="flex gap-2 pt-2">
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
                      </details>
                    </div>
                  </>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
      <BottomSheet
        open={showAvatarEditor}
        title={pendingAvatarFile ? 'Position your photo' : 'Edit profile image'}
        description={
          pendingAvatarFile
            ? 'Choose a crop or keep the whole image visible.'
            : 'Choose a photo or keep a personal emblem as your fallback.'
        }
        onClose={() => {
          if (!isSavingAvatar) {
            setPendingAvatarFile(null);
            setShowAvatarEditor(false);
          }
        }}
        footer={
          !pendingAvatarFile ? (
            <button
              type="button"
              onClick={() => setShowAvatarEditor(false)}
              disabled={isSavingAvatar}
              className="min-h-11 rounded-xl bg-brand-sage px-5 text-sm font-bold text-white"
            >
              Done
            </button>
          ) : undefined
        }
      >
        <input
          ref={avatarInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/bmp"
          className="sr-only"
          onChange={(event) => handleAvatarFile(event.target.files?.[0])}
        />
        {pendingAvatarFile ? (
          <>
            <AvatarCropper
              file={pendingAvatarFile}
              busy={isSavingAvatar}
              onCancel={() => avatarInputRef.current?.click()}
              onChoose={handleAvatarSelection}
            />
            {avatarError && (
              <p className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm font-semibold text-red-700 dark:border-red-900/40 dark:bg-red-950/20 dark:text-red-300">
                {avatarError}
              </p>
            )}
          </>
        ) : (
          <>
            <div className="flex justify-center">
              <span
                className="relative flex h-24 w-24 items-center justify-center overflow-hidden rounded-full border-2 border-brand-border text-5xl shadow-sm"
                style={{ backgroundColor: profileColor }}
              >
                <ProfileAvatar
                  profile={{
                    ...profile,
                    name: profileName,
                    avatarEmoji: profileEmoji,
                    avatarColor: profileColor,
                    avatarUri: profileAvatarUri,
                  }}
                />
              </span>
            </div>
            <div className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => avatarInputRef.current?.click()}
                disabled={isSavingAvatar}
                className="flex min-h-11 items-center justify-center gap-2 rounded-xl bg-brand-sage px-4 text-sm font-bold text-white disabled:opacity-50"
              >
                <ImagePlus className="h-4 w-4" />
                {isSavingAvatar
                  ? 'Preparing photo…'
                  : profileAvatarUri
                    ? 'Change photo'
                    : 'Choose photo'}
              </button>
              {profileAvatarUri && (
                <button
                  type="button"
                  onClick={() => {
                    setProfileAvatarUri(undefined);
                    setAvatarError('');
                  }}
                  disabled={isSavingAvatar}
                  className="flex min-h-11 items-center justify-center gap-2 rounded-xl border border-red-200 px-4 text-sm font-bold text-red-600 disabled:opacity-50 dark:border-red-900/50 dark:text-red-300"
                >
                  <Trash2 className="h-4 w-4" />
                  Remove photo
                </button>
              )}
            </div>
            {avatarError && (
              <p className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm font-semibold text-red-700 dark:border-red-900/40 dark:bg-red-950/20 dark:text-red-300">
                {avatarError}
              </p>
            )}
            <fieldset className="mt-6">
              <legend className="text-xs font-bold uppercase tracking-wider text-brand-sage">
                Emblem
              </legend>
              <div className="mt-3 flex flex-wrap gap-2">
                {['🌸', '☕', '🦊', '🥑', '🌿', '🎒', '🛹', '🎨', '✨', '🧘', '🦄', '🐳', '🐾'].map(
                  (emo) => (
                    <button
                      key={emo}
                      type="button"
                      aria-label={`Use ${emo} profile emblem`}
                      aria-pressed={profileEmoji === emo}
                      onClick={() => {
                        setProfileEmoji(emo);
                        setProfileAvatarUri(undefined);
                      }}
                      className={`h-11 w-11 rounded-full text-xl ${profileEmoji === emo ? 'border-2 border-brand-pink bg-brand-pink/10' : 'border border-brand-border'}`}
                    >
                      {emo}
                    </button>
                  ),
                )}
              </div>
            </fieldset>
            <fieldset className="mt-6">
              <legend className="text-xs font-bold uppercase tracking-wider text-brand-sage">
                Background
              </legend>
              <div className="mt-3 flex flex-wrap gap-3">
                {PREDEFINED_COLORS.map((col) => (
                  <button
                    key={col.hex}
                    type="button"
                    aria-label={`Use ${col.name} avatar color`}
                    aria-pressed={profileColor === col.hex}
                    onClick={() => setProfileColor(col.hex)}
                    className={`h-10 w-10 rounded-full border border-black/10 ${profileColor === col.hex ? 'ring-2 ring-brand-pink ring-offset-2' : ''}`}
                    style={{ backgroundColor: col.hex }}
                  />
                ))}
              </div>
            </fieldset>
          </>
        )}
      </BottomSheet>
    </div>
  );
}
