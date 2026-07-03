import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  ArrowLeft, Lock, Bell, Download, Upload, Trash2, 
  Check, ShieldCheck, RefreshCw, FileWarning,
  Plus, Tag, Smile, X, Sun, Moon, Cloud, LogOut, Database, CloudLightning,
  Fingerprint, Palette, Sliders, ChevronLeft, ChevronRight
} from 'lucide-react';
import { AppSettings, SecurityConfig, Mood, UserProfile } from '../types';
import { 
  getSecurityConfig, getAppSettings, saveAppSettings,
  exportEncryptedBackup, importEncryptedBackup, resetDatabase,
  PREDEFINED_TAGS, PREDEFINED_MOODS, getUserProfile, saveUserProfile,
  PREDEFINED_COLORS, getEntries, getNotes, getStorageUsageDetails, StorageDetails,
  saveSecurityConfig, getDefaultUserProfile, updatePinWithCurrentPin, isValidPin,
  bindGoogleRecoveryAccount
} from '../utils/storage';
import type { PinLength } from '../utils/storage';
import { User, Mail } from 'lucide-react';
import { auth } from '../utils/firebase';
import type { UserCredential } from 'firebase/auth';
import { syncLocalAndCloud, wipeCloudData, restoreFromCloud, getSyncComparison, SyncComparison } from '../utils/sync';
import { isNativePlatform } from '../platform';
import { secureAuthService } from '../platform/security';
import { persistNativeLocalStorageItem } from '../mobile/nativeStorageBridge';
import { signOutGoogleAuth, startGoogleAuth } from '../utils/googleAuth';

interface AppSettingsScreenProps {
  onBack: () => void;
  onResetSuccess: () => void;
  onShowToast?: (message: string, type?: 'success' | 'info' | 'warning' | 'error') => void;
}

const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

const formatGoogleAuthError = (err: any): string => {
  const message = err?.message || '';
  if (message.includes('VITE_GOOGLE_WEB_CLIENT_ID')) {
    return 'Mobile Google sign-in needs VITE_GOOGLE_WEB_CLIENT_ID in .env. Use the Google Cloud OAuth Web application client ID, then rebuild and reinstall the APK.';
  }
  if (err?.code === 'SIGN_IN_CANCELED' || message.includes('SIGN_IN_CANCELED')) {
    return 'Google sign-in was cancelled before it completed.';
  }
  if (err?.code === 'auth/invalid-credential' || message.includes('ID token')) {
    return 'Google sign-in returned an invalid token. Check that Google Cloud has an Android OAuth client for com.deardiary.app with this APK signing SHA-1, and that .env uses the OAuth Web client ID.';
  }
  if (err?.code === 'auth/unauthorized-domain') {
    const host = typeof window !== 'undefined' ? window.location.hostname : 'this domain';
    if (isNativePlatform()) {
      return 'Mobile Google sign-in should use native auth. Rebuild and reinstall the APK so the native Google flow is included.';
    }
    return `Google sign-in is not enabled for ${host}. Add this domain in Firebase Console > Authentication > Settings > Authorized domains.`;
  }
  if (err?.code === 'auth/popup-closed-by-user') {
    return 'Google sign-in was cancelled before it completed.';
  }
  return err?.message || 'Google sign-in failed.';
};

export default function AppSettingsScreen({
  onBack,
  onResetSuccess,
  onShowToast
}: AppSettingsScreenProps) {
  const [security, setSecurity] = useState<SecurityConfig>(getSecurityConfig());
  const [settings, setSettings] = useState<AppSettings>(getAppSettings());
  const [activeTab, setActiveTab] = useState<'profile' | 'security' | 'sync' | 'customize'>('profile');

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
  const [profile, setProfile] = useState<UserProfile>(() => getUserProfile());
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

  // Firebase auth & sync states
  const [currentUser, setCurrentUser] = useState<any>(null);
  const [authError, setAuthError] = useState('');
  const [isAuthLoading, setIsAuthLoading] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSyncedStr, setLastSyncedStr] = useState<string>('Never');
  const [syncStep, setSyncStep] = useState<number>(-1);
  
  // Sync conflict options for local reset state
  const [showSyncConflictModal, setShowSyncConflictModal] = useState<boolean>(false);
  const [pendingSyncUid, setPendingSyncUid] = useState<string | null>(null);
  const [syncComparison, setSyncComparison] = useState<SyncComparison | null>(null);

  // WebAuthn Passkey States
  const [isWebAuthnLoading, setIsWebAuthnLoading] = useState<boolean>(false);
  const [webAuthnError, setWebAuthnError] = useState<string>('');
  const [webAuthnSuccess, setWebAuthnSuccess] = useState<string>('');
  const [showSimulateFallback, setShowSimulateFallback] = useState<boolean>(false);

  useEffect(() => {
    const unsubscribe = auth.onAuthStateChanged((user) => {
      setCurrentUser(user);
      if (user) {
        const lastSync = localStorage.getItem('deardiary_last_sync');
        if (lastSync) {
          setLastSyncedStr(new Date(parseInt(lastSync)).toLocaleString());
        }
      }
    });
    return () => unsubscribe();
  }, []);

  const boundCloudUser = React.useMemo(() => {
    if (!currentUser || !security.linkedGoogleUid || currentUser.uid !== security.linkedGoogleUid) {
      return null;
    }
    return currentUser;
  }, [currentUser, security.linkedGoogleUid]);

  // Compute if local data is out of sync with cloud data
  const isOutOfSync = React.useMemo(() => {
    if (!boundCloudUser) return false;
    const lastSyncTimeStr = localStorage.getItem('deardiary_last_sync');
    const lastSyncTime = lastSyncTimeStr ? Number(lastSyncTimeStr) : 0;
    if (lastSyncTime === 0) return true; // Never synced

    const entries = getEntries();
    const notes = getNotes();

    const hasNewerEntry = entries.some(e => e.updatedAt > lastSyncTime);
    const hasNewerNote = notes.some(n => n.updatedAt > lastSyncTime);

    return hasNewerEntry || hasNewerNote;
  }, [boundCloudUser, lastSyncedStr]);

  // Compute storage usage details (text, photos, audio)
  const storageDetails = React.useMemo(() => {
    return getStorageUsageDetails();
  }, [lastSyncedStr]);

  const handleSyncNow = async (uid?: string) => {
    const targetUid = uid || currentUser?.uid;
    if (!targetUid) return;
    const currentSecurity = getSecurityConfig();
    if (!currentSecurity.linkedGoogleUid || currentSecurity.linkedGoogleUid !== targetUid) {
      setAuthError(`Please sign in with ${currentSecurity.linkedGoogleEmail || 'the Google account linked to this device'} before syncing.`);
      return;
    }
    setIsSyncing(true);
    setSyncStep(0);
    const delay = (ms: number) => new Promise(res => setTimeout(res, ms));
    try {
      await delay(350);
      setSyncStep(1);
      const comparison = await getSyncComparison(targetUid);
      setSyncComparison(comparison);

      if (comparison.isMismatch) {
        setPendingSyncUid(targetUid);
        setShowSyncConflictModal(true);
        setIsSyncing(false);
        setSyncStep(-1);
        return;
      }

      await delay(350);
      setSyncStep(2);
      await delay(400);
      setSyncStep(3);
      await syncLocalAndCloud(targetUid);
      await delay(300);
      setSyncStep(4);
      const now = Date.now();
      localStorage.setItem('deardiary_last_sync', String(now));
      persistNativeLocalStorageItem('deardiary_last_sync', String(now));
      setLastSyncedStr(new Date(now).toLocaleString());
      await delay(350);
      setSyncStep(5);
      await delay(550);
      if (onShowToast) {
        onShowToast('Cloud synchronization complete!', 'success');
      }
    } catch (err: any) {
      console.error(err);
      if (onShowToast) {
        onShowToast(err.message || 'Cloud sync encountered an issue.', 'error');
      }
    } finally {
      setIsSyncing(false);
      setSyncStep(-1);
    }
  };

  const handleMergeData = async () => {
    if (!pendingSyncUid) return;
    setIsSyncing(true);
    setShowSyncConflictModal(false);
    try {
      await syncLocalAndCloud(pendingSyncUid);
      const now = Date.now();
      localStorage.setItem('deardiary_last_sync', String(now));
      persistNativeLocalStorageItem('deardiary_last_sync', String(now));
      setLastSyncedStr(new Date(now).toLocaleString());
      if (onShowToast) {
        onShowToast('Local and Cloud databases merged successfully! App is refreshing...', 'success');
      }
      setTimeout(() => {
        window.location.reload();
      }, 1500);
    } catch (err: any) {
      console.error(err);
      if (onShowToast) {
        onShowToast(err.message || 'Failed to merge databases.', 'error');
      }
    } finally {
      setIsSyncing(false);
      setPendingSyncUid(null);
    }
  };

  const handleWipeCloud = async () => {
    if (!pendingSyncUid) return;
    setIsSyncing(true);
    setShowSyncConflictModal(false);
    try {
      await wipeCloudData(pendingSyncUid);
      // Run standard sync to upload the empty/reset local state
      await syncLocalAndCloud(pendingSyncUid);
      const now = Date.now();
      localStorage.setItem('deardiary_last_sync', String(now));
      persistNativeLocalStorageItem('deardiary_last_sync', String(now));
      setLastSyncedStr(new Date(now).toLocaleString());
      if (onShowToast) {
        onShowToast('Cloud database wiped and synchronized successfully.', 'success');
      }
    } catch (err: any) {
      console.error(err);
      if (onShowToast) {
        onShowToast(err.message || 'Failed to wipe cloud database.', 'error');
      }
    } finally {
      setIsSyncing(false);
      setPendingSyncUid(null);
    }
  };

  const handleRestoreFromCloud = async () => {
    if (!pendingSyncUid) return;
    setIsSyncing(true);
    setShowSyncConflictModal(false);
    try {
      await restoreFromCloud(pendingSyncUid);
      const now = Date.now();
      localStorage.setItem('deardiary_last_sync', String(now));
      persistNativeLocalStorageItem('deardiary_last_sync', String(now));
      setLastSyncedStr(new Date(now).toLocaleString());
      if (onShowToast) {
        onShowToast('Journal restored from cloud! App is refreshing...', 'success');
      }
      setTimeout(() => {
        window.location.reload();
      }, 1500);
    } catch (err: any) {
      console.error(err);
      if (onShowToast) {
        onShowToast(err.message || 'Failed to restore journal from cloud.', 'error');
      }
      setIsSyncing(false);
      setPendingSyncUid(null);
    }
  };

  const completeGoogleSyncSignIn = async (userCredential: UserCredential) => {
    const result = bindGoogleRecoveryAccount(userCredential.user);
    if (!result.ok) {
      await signOutGoogleAuth();
      setSecurity(result.config);
      setAuthError(result.error || 'Use the Google account linked to this device.');
      return;
    }
    setSecurity(result.config);
    if (onShowToast) {
      onShowToast(`Google sync connected as ${userCredential.user.email || 'your Google account'}.`, 'success');
    }
    await handleSyncNow(userCredential.user.uid);
  };

  const handleGoogleSignIn = async () => {
    setAuthError('');
    setIsAuthLoading(true);
    try {
      const userCredential = await startGoogleAuth('sync');
      await completeGoogleSyncSignIn(userCredential);
    } catch (err: any) {
      console.error(err);
      setAuthError(formatGoogleAuthError(err));
    } finally {
      setIsAuthLoading(false);
    }
  };

  const handleSignOutClick = async () => {
    try {
      await signOutGoogleAuth();
      if (onShowToast) {
        onShowToast('Signed out of cloud sync.', 'info');
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleToggleAutoSyncLaunch = (checked: boolean) => {
    const updated: AppSettings = { ...settings, autoSyncOnLaunch: checked };
    saveAppSettings(updated);
    setSettings(updated);
    if (onShowToast) {
      onShowToast(checked ? 'Auto-sync on launch enabled' : 'Auto-sync on launch disabled', 'info');
    }
  };

  const handleToggleSyncOnEntry = (checked: boolean) => {
    const updated: AppSettings = { ...settings, syncOnEntryCreation: checked };
    saveAppSettings(updated);
    setSettings(updated);
    if (onShowToast) {
      onShowToast(checked ? 'Sync on entry creation enabled' : 'Sync on entry creation disabled', 'info');
    }
  };

  // Effect to save settings on custom tags/moods change
  useEffect(() => {
    const updatedSettings: AppSettings = {
      ...settings,
      customTags,
      customMoods
    };
    saveAppSettings(updatedSettings);
    setSettings(updatedSettings);
  }, [customTags, customMoods]);

  const handleThemeChange = (newTheme: 'light' | 'dark') => {
    const updated: AppSettings = {
      ...settings,
      theme: newTheme
    };
    saveAppSettings(updated);
    setSettings(updated);
    if (newTheme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  };

  const handleAddCustomTag = () => {
    const tag = newTagInput.trim().toLowerCase();
    if (tag && !PREDEFINED_TAGS.includes(tag) && !customTags.includes(tag)) {
      setCustomTags([...customTags, tag]);
    }
    setNewTagInput('');
  };

  const handleRemoveCustomTag = (tag: string) => {
    setCustomTags(customTags.filter(t => t !== tag));
  };

  const handleAddCustomMood = () => {
    const name = newMoodNameInput.trim();
    const emoji = newMoodEmojiInput.trim();
    const existingNames = PREDEFINED_MOODS.map(m => m.name.toLowerCase());
    if (name && emoji && !existingNames.includes(name.toLowerCase()) && !customMoods.some(m => m.name.toLowerCase() === name.toLowerCase())) {
      setCustomMoods([...customMoods, { name, emoji }]);
    }
    setNewMoodNameInput('');
    setNewMoodEmojiInput('');
  };

  const handleRemoveCustomMood = (moodName: string) => {
    setCustomMoods(customMoods.filter(m => m.name !== moodName));
  };

  const handlePinChangeSubmit = (e: React.FormEvent) => {
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
      const updated = updatePinWithCurrentPin(currentPin, newPin);
      setSecurity(updated);
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
        isBiometricsSimulated: undefined
      };
      setSecurity(newConfig);
      saveSecurityConfig(newConfig);
      onShowToast?.('Biometric security disabled.', 'info');
      return;
    }

    setIsWebAuthnLoading(true);
    try {
      const result = await secureAuthService.enroll(currentUser?.email || profile.email || 'dear.diary.user');
      if (result) {
        const newConfig = {
          ...security,
          isBiometricsEnabled: true,
          passkeyCredentialId: result.credentialId,
          isBiometricsSimulated: !!result.simulated
        };
        setSecurity(newConfig);
        saveSecurityConfig(newConfig);
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

  const handleEnableSimulatedBiometrics = () => {
    const newConfig = {
      ...security,
      isBiometricsEnabled: true,
      passkeyCredentialId: 'simulated-passkey-id-12345',
      isBiometricsSimulated: true
    };
    setSecurity(newConfig);
    saveSecurityConfig(newConfig);
    setWebAuthnSuccess('Simulated device biometric unlock enabled successfully!');
    setShowSimulateFallback(false);
    setWebAuthnError('');
    onShowToast?.('Simulated biometric unlock enabled.', 'success');
  };

  const handleSaveProfile = (e: React.FormEvent) => {
    e.preventDefault();
    const defaultProfile = getDefaultUserProfile();
    const updatedProfile: UserProfile = {
      ...profile,
      name: profileName.trim() || defaultProfile.name,
      email: profileEmail.trim() || defaultProfile.email,
      bio: profileBio.trim(),
      avatarEmoji: profileEmoji,
      avatarColor: profileColor,
      writingGoal: profileWritingGoal
    };
    saveUserProfile(updatedProfile);
    setProfile(updatedProfile);
    if (onShowToast) {
      onShowToast('User Profile saved successfully!', 'success');
    }
  };

  const handleReminderToggle = (enabled: boolean) => {
    const updated: AppSettings = {
      ...settings,
      remindersEnabled: enabled
    };
    saveAppSettings(updated);
    setSettings(updated);
  };

  const handleReminderTimeChange = (timeStr: string) => {
    setReminderTime(timeStr);
    const updated: AppSettings = {
      ...settings,
      reminderTime: timeStr
    };
    saveAppSettings(updated);
    setSettings(updated);
  };

  const handleExportBackup = () => {
    if (!backupPassword) {
      setBackupMsg('Please provide a password for encryption.');
      return;
    }

    try {
      const encryptedString = exportEncryptedBackup(backupPassword);
      
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
    reader.onload = (e) => {
      const fileContent = e.target?.result as string;
      if (fileContent) {
        const success = importEncryptedBackup(fileContent, importPassword);
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

  const handleResetDatabase = () => {
    resetDatabase();
    onResetSuccess();
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
              id: 'sync' as const, 
              label: 'Sync & Backup', 
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
                        {['🌸', '☕', '🦊', '🥑', '🌿', '🎒', '🛹', '🎨', '✨', '🧘', '🦄', '🐳', '🐾'].map(emo => (
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
                          placeholder={currentUser?.displayName || "Your nickname"}
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
                          placeholder={currentUser?.email || "Email address"}
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
                          ⚡ Running in Preview Sandbox Simulation
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

          {activeTab === 'sync' && (
            <motion.div
              key="sync"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.15 }}
              className="flex flex-col gap-5"
            >
              {/* Firebase Cloud Sync & Backup card */}
              {boundCloudUser ? (
                <>
                  <div className="bg-gradient-to-br from-brand-card-bg to-brand-bg/60 p-6 rounded-3xl journal-shadow border border-brand-border flex flex-col gap-5 relative overflow-hidden group">
                    {/* Glowing background aura */}
                    <div className={`absolute -right-16 -top-16 w-36 h-36 rounded-full blur-3xl opacity-20 dark:opacity-30 transition-colors duration-700 ${isOutOfSync ? 'bg-amber-500' : 'bg-brand-sage'}`} />

                    <div className="flex items-center justify-between relative z-10">
                      <div className="flex items-center gap-3">
                        <span className={`p-3 rounded-2xl flex items-center justify-center transition-all duration-300 ${
                          isOutOfSync 
                            ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 animate-pulse' 
                            : 'bg-brand-sage/10 text-brand-sage'
                        }`}>
                          <Cloud className="w-5 h-5" />
                        </span>
                        <div>
                          <h3 className="text-sm font-bold text-brand-plum dark:text-brand-text">Cloud Sync Vault</h3>
                          <p className="text-[10px] text-brand-sage mt-0.5">End-to-end cloud protection and multi-device sync</p>
                        </div>
                      </div>

                      <div className="flex flex-col items-end">
                        {isOutOfSync ? (
                          <div className="px-3 py-1 bg-amber-500/10 text-amber-600 dark:text-amber-400 text-[10px] font-bold rounded-full flex items-center gap-1.5 border border-amber-500/20 shadow-sm animate-pulse">
                            <span className="w-1.5 h-1.5 bg-amber-500 rounded-full" />
                            Changes Pending
                          </div>
                        ) : (
                          <div className="px-3 py-1 bg-brand-sage/10 text-brand-sage text-[10px] font-bold rounded-full flex items-center gap-1.5 border border-brand-sage/20 shadow-sm">
                            <span className="w-1.5 h-1.5 bg-brand-sage rounded-full" />
                            Fully Secured
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-col gap-3.5 bg-brand-bg/55 dark:bg-brand-bg/15 p-4 rounded-2xl border border-brand-border/40 relative z-10 text-xs">
                      <div className="flex justify-between items-center">
                        <span className="text-brand-sage font-medium">Vault Account</span>
                        <span className="font-mono font-bold text-brand-plum dark:text-brand-text text-[11px] truncate max-w-[200px] flex items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-brand-sage animate-pulse" />
                          {boundCloudUser.email}
                        </span>
                      </div>

                      <div className="flex justify-between items-center border-t border-brand-border/25 pt-3">
                        <span className="text-brand-sage font-medium">Last Sync Event</span>
                        <span className="font-mono text-brand-sage font-bold text-[11px] flex items-center gap-1">
                          <RefreshCw className="w-3 h-3 text-brand-sage/60 animate-spin" style={{ animationDuration: '6s' }} />
                          {lastSyncedStr}
                        </span>
                      </div>

                      {isOutOfSync && (
                        <div className="text-[10px] text-amber-700 dark:text-amber-400 bg-amber-500/5 border border-amber-500/10 p-3 rounded-xl flex items-start gap-2.5 leading-normal mt-1 animate-fade-in">
                          <span className="text-sm">⚠️</span>
                          <p>
                            Your device has entries or notes created after the last cloud backup. 
                            Press <strong>Sync Now</strong> to secure them.
                          </p>
                        </div>
                      )}
                    </div>

                    {/* Cloud Storage Usage Breakdown */}
                    <div className="border-t border-brand-border/30 pt-5 flex flex-col gap-3 relative z-10">
                      <div className="flex justify-between items-center text-xs">
                        <span className="text-brand-plum dark:text-brand-text font-bold">Cloud Quota Usage</span>
                        <span className="font-mono text-[11px] font-bold text-brand-pink">
                          {((storageDetails.totalBytes / (1024 * 1024 * 1024)) * 100).toFixed(1)}%
                        </span>
                      </div>
                      <div className="text-[10px] text-brand-sage text-right font-mono -mt-1 mb-1">
                         {formatBytes(storageDetails.totalBytes)} <span className="text-brand-sage/60">/ 1 GB</span>
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
                        Scrapbook photos and audio entries are auto-compressed locally to preserve your secure 1 GB cloud allocation.
                      </p>
                    </div>

                    {/* Primary control buttons */}
                    <div className="grid grid-cols-2 gap-3 pt-3">
                      <button
                        type="button"
                        onClick={() => handleSyncNow()}
                        disabled={isSyncing}
                        className="py-3 bg-brand-pink hover:bg-brand-pink-dark text-white font-bold text-xs rounded-xl flex items-center justify-center gap-2 transition-all shadow-md shadow-brand-pink/15 active:scale-[0.98] disabled:opacity-50 select-none cursor-pointer"
                      >
                        <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
                        {isSyncing ? 'Syncing...' : 'Sync Now'}
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

                  {/* Synchronization Preferences Switchboard */}
                  <div className="bg-brand-card-bg p-6 rounded-3xl journal-shadow border border-brand-border flex flex-col gap-4">
                    <div className="flex items-center gap-3">
                      <span className="p-2.5 bg-brand-blush-light dark:bg-brand-blush-light/10 text-brand-pink rounded-2xl">
                        <Sliders className="w-4 h-4" />
                      </span>
                      <div>
                        <h3 className="text-sm font-bold text-brand-plum dark:text-brand-text">Synchronization Settings</h3>
                        <p className="text-[10px] text-brand-sage mt-0.5">Fine-tune how your journal stays backed up automatically</p>
                      </div>
                    </div>

                    <div className="flex flex-col gap-3.5 mt-1">
                      {/* Toggle 1: Auto Sync on Launch */}
                      <div className="flex items-center justify-between p-3 bg-brand-bg/40 dark:bg-brand-bg/10 rounded-2xl border border-brand-border/30 hover:border-brand-pink/20 transition-all">
                        <div className="flex flex-col gap-0.5 max-w-[80%]">
                          <span className="text-xs font-bold text-brand-plum dark:text-brand-text">Auto-Sync on App Launch</span>
                          <p className="text-[9px] text-brand-sage leading-relaxed">Automatically upload and download new entries as soon as you unlock your journal.</p>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input 
                            type="checkbox" 
                            checked={!!settings.autoSyncOnLaunch}
                            onChange={(e) => handleToggleAutoSyncLaunch(e.target.checked)}
                            className="sr-only peer" 
                          />
                          <div className="w-10 h-5.5 bg-brand-sage-light/55 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-brand-sage-light after:border after:rounded-full after:h-4.5 after:w-4.5 after:transition-all peer-checked:bg-brand-sage" />
                        </label>
                      </div>

                      {/* Toggle 2: Real-time sync on creation */}
                      <div className="flex items-center justify-between p-3 bg-brand-bg/40 dark:bg-brand-bg/10 rounded-2xl border border-brand-border/30 hover:border-brand-pink/20 transition-all">
                        <div className="flex flex-col gap-0.5 max-w-[80%]">
                          <span className="text-xs font-bold text-brand-plum dark:text-brand-text">Instant Backup on Entry Save</span>
                          <p className="text-[9px] text-brand-sage leading-relaxed">Instantly synchronize with your secure cloud vault whenever a new diary entry or note is saved.</p>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input 
                            type="checkbox" 
                            checked={!!settings.syncOnEntryCreation}
                            onChange={(e) => handleToggleSyncOnEntry(e.target.checked)}
                            className="sr-only peer" 
                          />
                          <div className="w-10 h-5.5 bg-brand-sage-light/55 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-brand-sage-light after:border after:rounded-full after:h-4.5 after:w-4.5 after:transition-all peer-checked:bg-brand-sage" />
                        </label>
                      </div>
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
                      <h3 className="text-sm font-bold text-brand-plum dark:text-brand-text">Optional Google Sync</h3>
                      <p className="text-[10px] text-brand-sage mt-0.5">Stay fully offline, or connect Google to back up this device</p>
                    </div>
                  </div>

                  <div className="text-[10.5px] leading-relaxed text-brand-text bg-brand-bg/30 dark:bg-white/5 p-3.5 rounded-2xl border border-brand-border/30">
                    <div className="flex gap-2.5 items-start">
                      <ShieldCheck className="w-4 h-4 text-brand-sage shrink-0 mt-0.5" />
                      <p className="text-brand-text-muted">
                        Google sign-in only enables backup and multi-device sync. Your local PIN and security question stay on this device.
                        {security.linkedGoogleEmail ? ` This device is linked to ${security.linkedGoogleEmail}.` : ''}
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
                        <span>{security.linkedGoogleEmail ? 'Reconnect Linked Google Account' : 'Connect Google Backup'}</span>
                      </>
                    )}
                  </button>
                </div>
              )}

              {/* Encrypted backups section */}
              <div className="bg-brand-card-bg p-5 rounded-3xl journal-shadow border border-brand-border flex flex-col gap-3">
                <h3 className="text-xs font-bold text-brand-sage uppercase tracking-wider mb-1">Encrypted Backups</h3>
                
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={() => { setShowBackupModal(true); setBackupMsg(''); }}
                    className="py-3 bg-brand-sage-light/20 hover:bg-brand-sage-light/40 border border-brand-sage-light text-brand-sage-dark text-xs font-bold rounded-2xl flex flex-col items-center gap-1.5 transition-all shadow-sm"
                  >
                    <Download className="w-4 h-4" />
                    Export Backup
                  </button>
                  <button
                    onClick={() => { setShowImportModal(true); setImportError(''); }}
                    className="py-3 bg-brand-blush-light hover:bg-brand-blush-dark border border-brand-rose-light text-brand-pink-dark text-xs font-bold rounded-2xl flex flex-col items-center gap-1.5 transition-all shadow-sm"
                  >
                    <Upload className="w-4 h-4" />
                    Import Backup
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
                  Need to erase your secrets? Resetting clears all entries, notes, and photo references. Your security PIN, decryption key, and reminder preferences will remain untouched.
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
                    placeholder="Emoji (e.g. 🌟)"
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

      {/* LOCAL RESET & SYNC CONFLICT DIALOG */}
      {showSyncConflictModal && (
        <div className="fixed inset-0 z-[200] flex items-start justify-center p-4 pb-28 bg-black/60 backdrop-blur-md overflow-y-auto">
          <div className="w-full max-w-lg bg-brand-card-bg rounded-3xl p-6 pb-4 journal-shadow border border-brand-border flex flex-col gap-5 max-h-[calc(100dvh-8rem)] overflow-y-auto mt-8 mb-24">
            <div className="flex items-center gap-3">
              <span className="p-3 bg-brand-blush-light dark:bg-brand-blush-light/10 text-brand-pink rounded-2xl shrink-0">
                <CloudLightning className="w-6 h-6 animate-pulse" />
              </span>
              <div>
                <h3 className="font-serif-diary text-lg font-bold text-brand-plum dark:text-brand-text">Sync Action Required</h3>
                <p className="text-[11px] text-brand-sage mt-0.5">
                  {syncComparison && syncComparison.localCount.entries === 0 && syncComparison.localCount.notes === 0
                    ? "Your local journal is empty, but existing data was found in the cloud."
                    : "A difference was detected between your local journal and the cloud database (e.g., from syncing with another device)."
                  }
                </p>
              </div>
            </div>

            {/* Counts Comparison Breakdown */}
            {syncComparison && (
              <div className="grid grid-cols-2 gap-3 bg-brand-bg/50 dark:bg-brand-bg/25 p-3 rounded-2xl border border-brand-border/40 text-xs">
                <div className="border-r border-brand-border/30 pr-2">
                  <span className="block font-bold text-brand-plum dark:text-brand-text mb-1">💻 Local Device</span>
                  <div className="text-[10px] text-brand-sage space-y-0.5">
                    <span className="block">• {syncComparison.localCount.diaries} Diaries</span>
                    <span className="block">• {syncComparison.localCount.entries} Entries</span>
                    <span className="block">• {syncComparison.localCount.notes} Notes</span>
                  </div>
                </div>
                <div className="pl-2">
                  <span className="block font-bold text-brand-plum dark:text-brand-text mb-1">☁️ Cloud Database</span>
                  <div className="text-[10px] text-brand-sage space-y-0.5">
                    <span className="block">• {syncComparison.cloudCount.diaries} Diaries</span>
                    <span className="block">• {syncComparison.cloudCount.entries} Entries</span>
                    <span className="block">• {syncComparison.cloudCount.notes} Notes</span>
                  </div>
                </div>
              </div>
            )}

            <p className="text-xs text-brand-plum/80 dark:text-brand-text/80 leading-relaxed bg-brand-bg/50 dark:bg-brand-bg/25 p-3 rounded-2xl border border-brand-border/40">
              Please choose how you would like to resolve this difference:
            </p>

            <div className="flex flex-col gap-3.5">
              {/* Option A: Merge Data (Only if local has some data) */}
              {syncComparison && !(syncComparison.localCount.entries === 0 && syncComparison.localCount.notes === 0) && (
                <button
                  type="button"
                  onClick={handleMergeData}
                  className="w-full text-left p-4 rounded-2xl border border-brand-border hover:border-brand-sage/60 hover:bg-brand-sage/5 transition-all flex items-start gap-3 group"
                >
                  <span className="p-2 bg-brand-sage/10 text-brand-sage rounded-xl group-hover:bg-brand-sage group-hover:text-white transition-all shrink-0">
                    <RefreshCw className="w-4 h-4" />
                  </span>
                  <div>
                    <h4 className="text-xs font-bold text-brand-plum dark:text-brand-text">1. Merge Both Databases (Recommended)</h4>
                    <p className="text-[10px] text-brand-sage mt-0.5">Combines local and cloud databases. Keeps items from both devices and resolves overlapping items using the newest timestamps.</p>
                  </div>
                </button>
              )}

              {/* Option B: Restore from Cloud */}
              <button
                type="button"
                onClick={handleRestoreFromCloud}
                className="w-full text-left p-4 rounded-2xl border border-brand-border hover:border-brand-sage/60 hover:bg-brand-sage/5 transition-all flex items-start gap-3 group"
              >
                <span className="p-2 bg-brand-sage/10 text-brand-sage rounded-xl group-hover:bg-brand-sage group-hover:text-white transition-all shrink-0">
                  <Database className="w-4 h-4" />
                </span>
                <div>
                  <h4 className="text-xs font-bold text-brand-plum dark:text-brand-text">
                    {syncComparison && syncComparison.localCount.entries === 0 && syncComparison.localCount.notes === 0
                      ? "1. Restore from Cloud (Recommended)"
                      : "2. Restore from Cloud"
                    }
                  </h4>
                  <p className="text-[10px] text-brand-sage mt-0.5">Completely download your cloud diaries, entries, and notes to overwrite this local device.</p>
                </div>
              </button>

              {/* Option C: Overwrite Cloud / Wipe Cloud */}
              <button
                type="button"
                onClick={handleWipeCloud}
                className="w-full text-left p-4 rounded-2xl border border-brand-border hover:border-red-200 hover:bg-red-50/30 transition-all flex items-start gap-3 group"
              >
                <span className="p-2 bg-red-50 dark:bg-red-950/20 text-red-600 rounded-xl group-hover:bg-red-600 group-hover:text-white transition-all shrink-0">
                  {syncComparison && syncComparison.localCount.entries === 0 && syncComparison.localCount.notes === 0
                    ? <Trash2 className="w-4 h-4" />
                    : <Upload className="w-4 h-4" />
                  }
                </span>
                <div>
                  <h4 className="text-xs font-bold text-red-600 dark:text-red-400">
                    {syncComparison && syncComparison.localCount.entries === 0 && syncComparison.localCount.notes === 0
                      ? "2. Wipe Data in Cloud"
                      : "3. Overwrite Cloud with Local Journal"
                    }
                  </h4>
                  <p className="text-[10px] text-brand-sage mt-0.5">
                    {syncComparison && syncComparison.localCount.entries === 0 && syncComparison.localCount.notes === 0
                      ? "Permanently delete all diaries, entries, and notes in the cloud to match your empty device."
                      : "Permanently replace the cloud database with your current local journal. Other devices will sync to this state."
                    }
                  </p>
                </div>
              </button>
            </div>

            <div className="sticky bottom-0 flex gap-3 pt-3 pb-1 bg-brand-card-bg border-t border-brand-border/40">
              <button
                type="button"
                onClick={() => { setShowSyncConflictModal(false); setPendingSyncUid(null); }}
                className="flex-1 py-3 rounded-full border border-brand-border text-brand-sage font-bold text-xs hover:bg-brand-bg transition-all bg-brand-card-bg shadow-sm"
              >
                Cancel Sync
              </button>
            </div>
          </div>
        </div>
      )}

      {/* SECURE SYNC PROGRESS STEPPER MODAL */}
      {syncStep >= 0 && activeTab === 'sync' && (
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
              <h3 className="font-serif-diary text-base font-bold text-brand-plum dark:text-brand-text">Encrypting & Syncing</h3>
              <p className="text-[10px] text-brand-sage mt-1">Please keep the application open. Securing your cloud vault...</p>
            </div>

            {/* Simulated Live Progress Bar */}
            <div className="w-full h-1.5 bg-brand-bg dark:bg-brand-bg/50 rounded-full overflow-hidden border border-brand-border/30">
              <motion.div 
                className="h-full bg-brand-pink"
                initial={{ width: "0%" }}
                animate={{ width: `${(syncStep + 1) * 16.66}%` }}
                transition={{ duration: 0.3, ease: "easeOut" }}
              />
            </div>

            {/* Steps Checklist */}
            <div className="flex flex-col gap-2.5 text-left mt-1.5 bg-brand-bg/40 dark:bg-white/5 p-3 rounded-2xl border border-brand-border/35">
              {[
                "Establishing secure cloud handshake",
                "Scanning client database sandbox delta",
                "Reconciling timeline collisions",
                "Encrypting diary payloads",
                "Synchronizing to remote Cloud Vault",
                "Vault synchronized successfully"
              ].map((stepText, index) => {
                const isCompleted = syncStep > index;
                const isCurrent = syncStep === index;

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
                          ✓
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
