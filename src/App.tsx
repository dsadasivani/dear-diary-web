import React, { Suspense, useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  AlertCircle, ArrowLeft, BarChart2, BookOpen, Check, ClipboardList, Eye, EyeOff,
  Fingerprint, Home, LoaderCircle, Lock, Plus, RefreshCw, Search, ShieldCheck, WifiOff, X
} from 'lucide-react';

import OverlayPortal from './components/OverlayPortal';
import ProfileAvatar from './components/ProfileAvatar';
import {
  AppHeader,
  CreateActionSheet,
  MobileBottomNavigation,
  NavigationRail,
  ProfileActionSheet,
} from './components/AppShellPrimitives';

import { AppSettings, Diary, Entry, PartitionHydrationState, ResponsiveLayout, SecurityConfig, UserProfile } from './types';
import type { NoteConversionRequest } from './components/NotesScreen';
import type { SettingsSection } from './components/AppSettingsScreen';
import type { RepositoryChange, SyncStatusSummary } from './repositories';
import { addNativeAppStateListener, addNativeBackListener, addNativeUrlOpenListener, exitNativeApp, getNativeLaunchUrl, syncNativeStatusBar } from './mobile/capacitorBootstrap';
import { DearDiaryDeepLinkTarget, parseDearDiaryDeepLink } from './mobile/deepLinks';
import { isAndroid, isNativePlatform } from './platform';

import { secureAuthService } from './platform/security';
import { diaryRepository, eventSyncEngine, syncV2Application } from './repositories';
import { isValidPin, unlockWithPin } from './domain/security';
import useResponsiveLayout from './hooks/useResponsiveLayout';
import { calculateStreak } from './domain/journalCatalog';
import { shouldLockAfterBackground } from './domain/privacyLock';
import { loadPendingPrimaryRecovery, resumePendingPrimaryRecovery } from './sync/accountBootstrap';
import { createConfiguredSupabaseControlPlaneClient } from './sync/config';
import { resumePendingDeviceKeyRotation } from './sync/deviceKeyRotation';
import { loadSyncSecrets } from './sync/syncSecrets';
import { restoreGoogleDriveSession } from './utils/googleAuth';
import { reportUnexpectedError } from './infrastructure/telemetry/reportUnexpectedError';
import { applyThemePreference, getLocalThemePreference, setLocalThemePreference } from './utils/themePreference';
import { measureAsync } from './utils/performance';

const LockScreen = React.lazy(() => import('./components/LockScreen'));
const HomeScreen = React.lazy(() => import('./components/HomeScreen'));
const DiariesScreen = React.lazy(() => import('./components/DiariesScreen'));
const DiaryDetailScreen = React.lazy(() => import('./components/DiaryDetailScreen'));
const DiarySettingsScreen = React.lazy(() => import('./components/DiarySettingsScreen'));
const EntryEditorScreen = React.lazy(() => import('./components/EntryEditorScreen'));
const NotesScreen = React.lazy(() => import('./components/NotesScreen'));
const SearchScreen = React.lazy(() => import('./components/SearchScreen'));
const StatsScreen = React.lazy(() => import('./components/StatsScreen'));
const AppSettingsScreen = React.lazy(() => import('./components/AppSettingsScreen'));

interface AppProps {
  initialSettings: AppSettings;
  initialSecurity: SecurityConfig;
  initialUserProfile: UserProfile;
}

type GlobalLoadingState = {
  message: string;
  detail?: string;
};

const GlobalLoaderOverlay = ({ loading }: { loading: GlobalLoadingState | null }) => (
  <AnimatePresence>
    {loading && (
      <OverlayPortal>
        <motion.div
          key="global-loader"
          className="fixed inset-0 z-[120] flex items-center justify-center bg-brand-bg/65 px-5 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
        >
          <motion.div
            className="flex w-full max-w-xs flex-col items-center gap-3 rounded-2xl border border-brand-border bg-white/95 p-5 text-center shadow-2xl dark:bg-brand-card-bg/95"
            initial={{ opacity: 0, y: 16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.97 }}
            transition={{ type: 'spring', stiffness: 320, damping: 24 }}
          >
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-pink/10 text-brand-pink">
              <LoaderCircle className="h-6 w-6 animate-spin" />
            </span>
            <div className="space-y-1">
              <p className="text-sm font-extrabold text-brand-plum dark:text-brand-text">{loading.message}</p>
              {loading.detail && (
                <p className="text-[11px] font-semibold leading-relaxed text-brand-text-muted">{loading.detail}</p>
              )}
            </div>
          </motion.div>
        </motion.div>
      </OverlayPortal>
    )}
  </AnimatePresence>
);

const ScreenFallback = () => (
  <div className="flex min-h-[12rem] w-full items-center justify-center text-brand-sage">
    <LoaderCircle className="h-6 w-6 animate-spin" />
  </div>
);

const isLikelyCellularConnection = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as any;
  const connection = nav.connection || nav.mozConnection || nav.webkitConnection;
  const connectionType = String(connection?.type || '').toLowerCase();
  const effectiveType = String(connection?.effectiveType || '').toLowerCase();
  return connectionType === 'cellular' || ['slow-2g', '2g', '3g'].includes(effectiveType);
};

const isE2eAppMode = (): boolean => {
  if (import.meta.env.VITE_DEAR_DIARY_E2E !== '1') return false;
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).has('e2eApp');
};

export default function App({ initialSettings, initialSecurity, initialUserProfile }: AppProps) {
  const layout: ResponsiveLayout = useResponsiveLayout();
  const isDesktop = layout === 'desktop';

  // Authentication states
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [isOnline, setIsOnline] = useState<boolean>(() => typeof navigator === 'undefined' || navigator.onLine);
  const [syncAuthorizationMessage, setSyncAuthorizationMessage] = useState('');
  const [isReauthorizingSync, setIsReauthorizingSync] = useState(false);
  const [desktopSearchQuery, setDesktopSearchQuery] = useState('');
  const [searchInitialQuery, setSearchInitialQuery] = useState('');
  const [settingsInitialSection, setSettingsInitialSection] = useState<SettingsSection>('profile');
  
  // Navigation states
  const [activeTab, setActiveTab] = useState<string>('home'); // home, diaries, notes, search, stats
  const [currentScreen, setCurrentScreen] = useState<string>('list'); // list, diaryDetail, diarySettings, entryEditor, appSettings
  const [isEditorFocusMode, setIsEditorFocusMode] = useState<boolean>(false);
  const [isCreateSheetOpen, setIsCreateSheetOpen] = useState(false);
  const [isProfileSheetOpen, setIsProfileSheetOpen] = useState(false);
  
  // Selected resource IDs for deep links
  const [selectedDiaryId, setSelectedDiaryId] = useState<string>('');
  const [selectedEntryId, setSelectedEntryId] = useState<string>('');
  const [selectedDate, setSelectedDate] = useState<string>('');
  const [selectedNoteId, setSelectedNoteId] = useState<string>('');

  // Per-diary session unlock state
  const [unlockedDiaryIds, setUnlockedDiaryIds] = useState<Set<string>>(() => new Set());
  const [diaryUnlockPin, setDiaryUnlockPin] = useState<string>('');
  const [showDiaryUnlockPin, setShowDiaryUnlockPin] = useState<boolean>(false);
  const [diaryUnlockError, setDiaryUnlockError] = useState<string>('');
  const [diaryUnlockSuccess, setDiaryUnlockSuccess] = useState<string>('');
  const [isDiaryBiometricUnlocking, setIsDiaryBiometricUnlocking] = useState<boolean>(false);
  
  // Toast notification state
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' | 'warning' } | null>(null);
  const [globalLoading, setGlobalLoading] = useState<GlobalLoadingState | null>(null);
  const loadingDepthRef = React.useRef(0);
  const pendingDeepLinkRef = React.useRef<DearDiaryDeepLinkTarget | null>(null);

  const showToast = (message: string, type: 'success' | 'error' | 'info' | 'warning' = 'success') => {
    setToast({ message, type });
  };

  const runWithGlobalLoader = useCallback(async (
    message: string,
    operation: () => Promise<void>,
    detail?: string
  ) => {
    loadingDepthRef.current += 1;
    setGlobalLoading({ message, detail });
    try {
      await operation();
    } finally {
      loadingDepthRef.current = Math.max(0, loadingDepthRef.current - 1);
      if (loadingDepthRef.current === 0) {
        setGlobalLoading(null);
      }
    }
  }, []);

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => {
        setToast(null);
      }, 3500);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  // Active data states (refreshed from storage on updates)
  const [diaries, setDiaries] = useState<Diary[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [settings, setSettings] = useState<AppSettings>(initialSettings);
  const [security, setSecurity] = useState<SecurityConfig>(initialSecurity);
  const [userProfile, setUserProfile] = useState<UserProfile>(initialUserProfile);
  const [archiveMonths, setArchiveMonths] = useState<PartitionHydrationState[]>([]);
  const [syncStatus, setSyncStatus] = useState<SyncStatusSummary | null>(null);
  const [homeStreak, setHomeStreak] = useState(0);

  const lockedDiaryIds = React.useMemo(() => (
    diaries
      .filter(diary => diary.isLocked && !unlockedDiaryIds.has(diary.id))
      .map(diary => diary.id)
  ), [diaries, unlockedDiaryIds]);

  const accessibleEntries = React.useMemo(() => {
    const lockedDiaryIdSet = new Set(lockedDiaryIds);
    return entries.filter(entry => !lockedDiaryIdSet.has(entry.diaryId));
  }, [entries, lockedDiaryIds]);

  const visibleStreak = React.useMemo(
    () => accessibleEntries.length > 0 ? calculateStreak(accessibleEntries) : homeStreak,
    [accessibleEntries, homeStreak],
  );

  // Reload data from the async repository. SQLite is authoritative on native.
  const reloadData = async () => {
    await measureAsync('app.reloadData', async () => {
    const [storedDiaries, storedEntries, storedProfile, storedSettings, storedSecurity, storedArchiveMonths, storedSyncStatus] = await Promise.all([
      diaryRepository.listDiaries(),
      diaryRepository.listEntries(),
      diaryRepository.getUserProfile(),
      diaryRepository.getSettings(),
      diaryRepository.getSecurityConfig(),
      diaryRepository.listAvailableArchiveMonths(),
      diaryRepository.getSyncStatusSummary(),
    ]);
    setDiaries(storedDiaries);
    setEntries(storedEntries);
    setUserProfile(storedProfile);
    setHomeStreak(calculateStreak(storedEntries));
    const currentTheme = getLocalThemePreference(storedSettings.theme || 'light');
    setSettings({ ...storedSettings, theme: currentTheme });
    setSecurity(storedSecurity);
    setArchiveMonths(storedArchiveMonths);
    setSyncStatus(storedSyncStatus);
    applyThemePreference(currentTheme);
    void syncNativeStatusBar(currentTheme);
    });
  };

  const reloadShellData = async () => {
    await measureAsync('app.reloadShellData', async () => {
      const [storedDiaries, storedProfile, storedSettings, storedSecurity, storedArchiveMonths, storedSyncStatus, storedHomeSummary] = await Promise.all([
        diaryRepository.listDiaries(),
        diaryRepository.getUserProfile(),
        diaryRepository.getSettings(),
        diaryRepository.getSecurityConfig(),
        diaryRepository.listAvailableArchiveMonths(),
        diaryRepository.getSyncStatusSummary(),
        diaryRepository.getHomeSummary(),
      ]);
      setDiaries(storedDiaries);
      setUserProfile(storedProfile);
      setHomeStreak(storedHomeSummary.currentStreak);
      const currentTheme = getLocalThemePreference(storedSettings.theme || 'light');
      setSettings({ ...storedSettings, theme: currentTheme });
      setSecurity(storedSecurity);
      setArchiveMonths(storedArchiveMonths);
      setSyncStatus(storedSyncStatus);
      applyThemePreference(currentTheme);
      void syncNativeStatusBar(currentTheme);
    });
  };

  const handleLocalThemeChange = (nextTheme: 'light' | 'dark') => {
    setLocalThemePreference(nextTheme);
    setSettings(prev => ({ ...prev, theme: nextTheme }));
    void syncNativeStatusBar(nextTheme);
  };

  const applyRepositoryChange = useCallback((change: RepositoryChange) => {
    switch (change.type) {
      case 'entry-created':
        setEntries(prev => [...prev.filter(entry => entry.id !== change.entry.id), change.entry]);
        void diaryRepository.listDiaries().then(setDiaries).catch(() => undefined);
        break;
      case 'entry-updated':
        setEntries(prev => prev.map(entry => entry.id === change.entry.id ? change.entry : entry));
        void diaryRepository.listDiaries().then(setDiaries).catch(() => undefined);
        break;
      case 'entry-deleted':
        setEntries(prev => prev.filter(entry => entry.id !== change.entryId));
        void diaryRepository.listDiaries().then(setDiaries).catch(() => undefined);
        break;
      case 'diary-created':
        setDiaries(prev => [...prev.filter(diary => diary.id !== change.diary.id), change.diary]);
        break;
      case 'diary-updated':
        setDiaries(prev => prev.map(diary => diary.id === change.diary.id ? change.diary : diary));
        break;
      case 'diary-deleted':
        setDiaries(prev => prev.filter(diary => diary.id !== change.diaryId));
        setEntries(prev => prev.filter(entry => entry.diaryId !== change.diaryId));
        break;
      case 'note-created':
      case 'note-updated':
      case 'note-deleted':
        break;
      case 'settings-updated': {
        const currentTheme = getLocalThemePreference(change.settings.theme || 'light');
        setSettings({ ...change.settings, theme: currentTheme });
        applyThemePreference(currentTheme);
        void syncNativeStatusBar(currentTheme);
        break;
      }
      case 'profile-updated':
        setUserProfile(change.profile);
        break;
      case 'sync-status-updated':
        setSyncStatus(change.status);
        break;
      case 'remote-batch-applied':
        void reloadShellData();
        break;
      default:
        break;
    }
  }, []);

  const refreshDiaries = async () => {
    setDiaries(await diaryRepository.listDiaries());
  };

  const refreshEntries = async () => {
    const [storedEntries, storedDiaries] = await Promise.all([
      diaryRepository.listEntries(),
      diaryRepository.listDiaries(),
    ]);
    setEntries(storedEntries);
    setDiaries(storedDiaries);
  };

  const resumePendingSyncWorkAfterUnlock = async () => {
    await syncV2Application.resumeAfterUnlock();
    const activeV2Account = await diaryRepository.getLocalSyncAccountState();
    if (activeV2Account?.syncProtocolVersion === 2) return activeV2Account;
    const secrets = await loadSyncSecrets();
    const pendingRecovery = await loadPendingPrimaryRecovery();
    const accessToken = secrets?.supabaseSession.accessToken || pendingRecovery?.supabaseSession.accessToken;
    if (pendingRecovery && !accessToken) {
      throw new Error('Primary recovery is pending but sync authorization is unavailable. Reconnect Google and Supabase to finish recovery.');
    }
    if (pendingRecovery && accessToken) {
      const controlPlane = createConfiguredSupabaseControlPlaneClient(accessToken);
      const googleSession = await restoreGoogleDriveSession(false).catch(() => null)
        || secrets?.googleSession
        || pendingRecovery.googleSession
        || null;
      const result = await resumePendingPrimaryRecovery({
        repository: diaryRepository,
        controlPlane,
        googleSession,
      });
      if (result.status === 'completed' || result.status === 'aborted') {
        showToast(result.message, 'info');
        await reloadShellData();
      }
    }
    const refreshedAccount = await diaryRepository.getLocalSyncAccountState();
    if (!refreshedAccount || refreshedAccount.deviceRole !== 'primary_mobile') return refreshedAccount;
    const refreshedSecrets = await loadSyncSecrets();
    if (!refreshedSecrets) return refreshedAccount;
    const controlPlane = createConfiguredSupabaseControlPlaneClient(refreshedSecrets.supabaseSession.accessToken);
    const googleSession = await restoreGoogleDriveSession(false).catch(() => null) || refreshedSecrets.googleSession || null;
    const result = await resumePendingDeviceKeyRotation({
      repository: diaryRepository,
      controlPlane,
      googleSession,
    });
    if (result.status === 'completed' || result.status === 'aborted') {
      showToast(result.message, 'info');
      await reloadShellData();
    }
    return diaryRepository.getLocalSyncAccountState();
  };

  const handleUnlock = async () => {
    await runWithGlobalLoader('Unlocking your diary', async () => {
      await measureAsync('app.pinUnlock', () => reloadShellData());
      setUnlockedDiaryIds(new Set());
      setIsAuthenticated(true);
    }, 'Loading your latest local data.');
    if (isE2eAppMode()) return;
    void resumePendingSyncWorkAfterUnlock()
      .then(syncAccount => {
        if (syncAccount) {
          eventSyncEngine.requestOutboxFlush();
          eventSyncEngine.startPolling();
        }
      })
      .catch(err => {
        showToast(err?.message || 'Encrypted sync could not resume after unlock.', 'warning');
        console.warn('Unable to start sync polling after unlock:', err);
      });
  };

  // On mount: load initial state
  useEffect(() => {
    void reloadShellData();
    setIsAuthenticated(false);
    return () => eventSyncEngine.stopPolling();
  }, []);

  useEffect(() => {
    if (isAuthenticated || isNativePlatform()) return;
    let cancelled = false;
    void diaryRepository.getLocalSyncAccountState().then(async syncAccount => {
      if (cancelled || syncAccount?.deviceRole !== 'web_companion') return;
      await syncV2Application.startIfActive();
      eventSyncEngine.startPolling();
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated]);

  useEffect(() => {
    const handleAuthorizationRequired = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: string }>).detail;
      setSyncAuthorizationMessage(detail?.message || 'Reconnect your account to resume sync.');
    };
    window.addEventListener('deardiary-sync-auth-required', handleAuthorizationRequired);
    return () => window.removeEventListener('deardiary-sync-auth-required', handleAuthorizationRequired);
  }, []);

  useEffect(() => {
    const handleMediaStorageWarning = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: string }>).detail;
      showToast(detail?.message || 'Media storage failed; keeping an inline copy for now.', 'warning');
    };
    window.addEventListener('deardiary-media-storage-warning', handleMediaStorageWarning);
    return () => window.removeEventListener('deardiary-media-storage-warning', handleMediaStorageWarning);
  }, []);

  useEffect(() => {
    const handleSyncConflict = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: string }>).detail;
      showToast(detail?.message || 'Conflict preserved as recovered copy.', 'warning');
      void diaryRepository.getSyncStatusSummary().then(setSyncStatus).catch(() => undefined);
    };
    window.addEventListener('deardiary-sync-conflict', handleSyncConflict);
    return () => window.removeEventListener('deardiary-sync-conflict', handleSyncConflict);
  }, []);

  const handleSyncReauthorization = async () => {
    setIsReauthorizingSync(true);
    try {
      await runWithGlobalLoader('Reconnecting encrypted sync', async () => {
        await eventSyncEngine.reauthorize();
        setSyncAuthorizationMessage('');
        await eventSyncEngine.pullPending();
      }, 'Checking Google Drive and bringing in pending updates.');
      showToast('Encrypted sync reconnected.', 'success');
    } catch (reauthorizationError: any) {
      showToast(reauthorizationError?.message || 'Sync reconnection failed.', 'error');
    } finally {
      setIsReauthorizingSync(false);
    }
  };

  const handleHydrateArchiveMonth = async (partitionKey: string) => {
    try {
      showToast('Restoring that archive month…', 'info');
      await runWithGlobalLoader('Restoring archive month', async () => {
        await eventSyncEngine.hydrateArchivePartition(partitionKey);
        await reloadShellData();
      }, 'Downloading older encrypted entries.');
      showToast('Archive month restored.', 'success');
    } catch (archiveError: any) {
      const message = archiveError?.message || 'Could not restore that archive month yet.';
      await reloadShellData();
      showToast(message, 'error');
      throw archiveError;
    }
  };

  const handleHydrateAllArchiveMonths = async () => {
    const candidates = (await diaryRepository.listAvailableArchiveMonths())
      .filter(month => month.status !== 'hydrated' && month.status !== 'not_available' && month.status !== 'hydrating');
    if (candidates.length === 0) {
      showToast('All available archive months are already restored.', 'info');
      return;
    }
    if (isLikelyCellularConnection()) {
      const message = 'Connect to Wi-Fi before restoring the full encrypted archive.';
      showToast(message, 'warning');
      throw new Error(message);
    }

    let restoredCount = 0;
    let failedCount = 0;
    showToast(`Restoring ${candidates.length} archive month${candidates.length === 1 ? '' : 's'} on Wi-Fi…`, 'info');
    await runWithGlobalLoader(`Restoring ${candidates.length} archive month${candidates.length === 1 ? '' : 's'}`, async () => {
      for (const candidate of candidates) {
        try {
          await eventSyncEngine.hydrateArchivePartition(String(candidate.partitionKey));
          restoredCount += 1;
          await reloadShellData();
        } catch {
          failedCount += 1;
        }
      }
      await reloadShellData();
    }, 'Keep the app open while older entries come back.');
    if (failedCount > 0) {
      const message = `Restored ${restoredCount} archive month${restoredCount === 1 ? '' : 's'}. ${failedCount} need retry later.`;
      showToast(message, restoredCount > 0 ? 'warning' : 'error');
      if (restoredCount === 0) throw new Error(message);
      return;
    }
    showToast(`Restored ${restoredCount} archive month${restoredCount === 1 ? '' : 's'}.`, 'success');
  };

  useEffect(() => {
    const updateOnlineState = () => {
      setIsOnline(navigator.onLine);
      if (navigator.onLine) eventSyncEngine.requestOutboxFlush();
      void diaryRepository.getSyncStatusSummary().then(setSyncStatus).catch(() => undefined);
    };
    window.addEventListener('online', updateOnlineState);
    window.addEventListener('offline', updateOnlineState);
    return () => {
      window.removeEventListener('online', updateOnlineState);
      window.removeEventListener('offline', updateOnlineState);
    };
  }, []);

  useEffect(() => diaryRepository.subscribeChanges((_revision, change) => {
    if (!isAuthenticated) return;
    if (change) {
      applyRepositoryChange(change);
      return;
    }
    void reloadShellData();
  }), [applyRepositoryChange, isAuthenticated]);

  useEffect(() => {
    const handleUnexpectedRejection = (event: PromiseRejectionEvent) => {
      reportUnexpectedError('window.unhandledrejection', event.reason);
    };
    window.addEventListener('unhandledrejection', handleUnexpectedRejection);
    return () => window.removeEventListener('unhandledrejection', handleUnexpectedRejection);
  }, []);

  const [selectedPrompt, setSelectedPrompt] = useState<string>('');

  // Handler to navigate between tabs & sub-screens
  const handleNavigate = (
    tab: string, 
    screen: string = 'list', 
    diaryId: string = '', 
    entryId: string = '', 
    dateStr: string = '', 
    noteId: string = '',
    promptText: string = ''
  ) => {
    setActiveTab(tab);
    setCurrentScreen(screen);
    setSelectedDiaryId(diaryId);
    setSelectedEntryId(entryId);
    setSelectedDate(dateStr);
    setSelectedNoteId(noteId);
    setSelectedPrompt(promptText);
    setIsEditorFocusMode(false);
  };

  const handleDesktopSearchSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmedQuery = desktopSearchQuery.trim();
    if (!trimmedQuery) {
      handleNavigate('search');
      return;
    }
    setSearchInitialQuery(trimmedQuery);
    handleNavigate('search');
  };

  const handleDesktopNewEntry = () => {
    const targetDiary = diaries[0];
    if (targetDiary) {
      handleNavigate('diaries', 'entryEditor', targetDiary.id);
      return;
    }
    handleNavigate('diaries');
  };

  const handleLockSettingsChange = async (nextSettings: AppSettings) => {
    await diaryRepository.saveSettings(nextSettings);
    setSettings(nextSettings);
  };

  const handleCreateEntry = (capture?: 'voice' | 'photo') => {
    const targetDiary = diaries[0];
    if (!targetDiary) {
      handleNavigate('diaries');
      showToast('Create a journal before adding your first entry.', 'info');
      return;
    }
    handleNavigate(
      'diaries',
      'entryEditor',
      targetDiary.id,
      '',
      '',
      '',
      capture === 'voice' ? 'Voice reflection' : capture === 'photo' ? 'Photo memory' : '',
    );
  };

  const rootPageTitle = () => ({
    home: 'Today',
    diaries: 'Journals',
    notes: 'Notes',
    search: 'Search',
    stats: currentScreen === 'appSettings' ? 'Settings' : 'Insights',
  }[activeTab] || 'Dear Diary');

  const navigateToDeepLink = useCallback(async (target: DearDiaryDeepLinkTarget) => {
    switch (target.kind) {
      case 'home':
        handleNavigate('home');
        return;
      case 'diaries':
        handleNavigate('diaries');
        return;
      case 'diary':
        handleNavigate('diaries', 'diaryDetail', target.diaryId, target.entryId || '');
        return;
      case 'entry': {
        let diaryId = target.diaryId;
        if (!diaryId) {
          const entry = await diaryRepository.getEntry(target.entryId);
          diaryId = entry?.diaryId || '';
        }
        if (!diaryId) {
          showToast('That diary link is no longer available.', 'warning');
          return;
        }
        handleNavigate('diaries', 'diaryDetail', diaryId, target.entryId);
        return;
      }
      case 'notes':
        handleNavigate('notes', 'list', '', '', '', target.noteId || '');
        return;
      case 'search':
        setSearchInitialQuery(target.query || '');
        handleNavigate('search');
        return;
      case 'stats':
        handleNavigate('stats');
        return;
      case 'settings':
        handleNavigate('stats', 'appSettings');
        return;
      default:
        return;
    }
  }, []);

  const handleDeepLinkUrl = useCallback((url: string) => {
    const target = parseDearDiaryDeepLink(url);
    if (!target) {
      showToast('That Dear Diary link could not be opened.', 'warning');
      return;
    }
    if (!isAuthenticated) {
      pendingDeepLinkRef.current = target;
      showToast('Unlock Dear Diary to continue.', 'info');
      return;
    }
    void navigateToDeepLink(target);
  }, [isAuthenticated, navigateToDeepLink]);

  useEffect(() => {
    if (!isNativePlatform()) return undefined;
    let disposed = false;
    void getNativeLaunchUrl().then(url => {
      if (!disposed && url) handleDeepLinkUrl(url);
    }).catch(() => undefined);
    const removeListener = addNativeUrlOpenListener(({ url }) => handleDeepLinkUrl(url));
    return () => {
      disposed = true;
      removeListener();
    };
  }, [handleDeepLinkUrl]);

  useEffect(() => {
    if (!isAuthenticated || !pendingDeepLinkRef.current) return;
    const target = pendingDeepLinkRef.current;
    pendingDeepLinkRef.current = null;
    void navigateToDeepLink(target);
  }, [isAuthenticated, navigateToDeepLink]);

  useEffect(() => {
    setDiaryUnlockPin('');
    setShowDiaryUnlockPin(false);
    setDiaryUnlockError('');
    setDiaryUnlockSuccess('');
    setIsDiaryBiometricUnlocking(false);
  }, [selectedDiaryId, currentScreen]);

  const markDiaryUnlocked = (diaryId: string) => {
    setUnlockedDiaryIds(prev => {
      const next = new Set(prev);
      next.add(diaryId);
      return next;
    });
  };

  const handleDiaryPinUnlock = async (diary: Diary) => {
    const requiredLength = security.pinLength || 4;
    if (!isValidPin(diaryUnlockPin, security.pinLength)) {
      setDiaryUnlockError(`Enter your ${requiredLength}-digit app PIN.`);
      setDiaryUnlockSuccess('');
      return;
    }

    const unlockedSecurity = unlockWithPin(security, diaryUnlockPin);
    if (unlockedSecurity) {
      await diaryRepository.saveSecurityConfig(unlockedSecurity);
      setSecurity(unlockedSecurity);
      markDiaryUnlocked(diary.id);
      setDiaryUnlockPin('');
      setDiaryUnlockError('');
      setDiaryUnlockSuccess(`${diary.name} unlocked.`);
      showToast(`${diary.name} unlocked.`, 'success');
      return;
    }

    setDiaryUnlockPin('');
    setDiaryUnlockSuccess('');
    setDiaryUnlockError('Incorrect app PIN.');
  };

  const handleDiaryBiometricUnlock = async (diary: Diary) => {
    if (!isNativePlatform() || !security.isBiometricsEnabled) {
      setDiaryUnlockError('Biometric unlock is not enabled. Use your app PIN.');
      setDiaryUnlockSuccess('');
      return;
    }

    setIsDiaryBiometricUnlocking(true);
    setDiaryUnlockError('');
    setDiaryUnlockSuccess('Checking biometric identity...');

    if (security.isBiometricsSimulated) {
      setTimeout(() => {
        markDiaryUnlocked(diary.id);
        setIsDiaryBiometricUnlocking(false);
        setDiaryUnlockSuccess(`${diary.name} unlocked.`);
        showToast(`${diary.name} unlocked.`, 'success');
      }, 700);
      return;
    }

    try {
      const success = await secureAuthService.authenticate(security.passkeyCredentialId);
      if (success) {
        markDiaryUnlocked(diary.id);
        setDiaryUnlockSuccess(`${diary.name} unlocked.`);
        showToast(`${diary.name} unlocked.`, 'success');
      } else {
        setDiaryUnlockSuccess('');
        setDiaryUnlockError('Biometric identity was not confirmed. Use your app PIN.');
      }
    } catch (err: any) {
      console.error(err);
      setDiaryUnlockSuccess('');
      setDiaryUnlockError(err?.name === 'NotAllowedError' ? 'Biometric prompt closed. Use your app PIN.' : (err?.message || 'Biometric unlock failed. Use your app PIN.'));
    } finally {
      setIsDiaryBiometricUnlocking(false);
    }
  };

  const handleLockApp = () => {
    eventSyncEngine.stopPolling();
    setUnlockedDiaryIds(new Set());
    setIsAuthenticated(false);
  };

  useEffect(() => {
    if (!isNativePlatform()) return undefined;
    let backgroundedAt: number | null = null;
    return addNativeAppStateListener(({ isActive }) => {
      if (!isActive) {
        backgroundedAt = Date.now();
        return;
      }
      if (isAuthenticated && shouldLockAfterBackground({ backgroundedAt, resumedAt: Date.now() })) {
        showToast('Dear Diary locked after being in the background.', 'info');
        handleLockApp();
      } else if (isAuthenticated) {
        eventSyncEngine.requestOutboxFlush();
      }
      backgroundedAt = null;
    });
  }, [isAuthenticated]);

  useEffect(() => {
    const handleRevokedDevice = () => {
      showToast('This device was revoked and its encrypted cache was cleared.', 'warning');
      handleLockApp();
      window.setTimeout(() => window.location.reload(), 300);
    };
    window.addEventListener('deardiary-device-revoked', handleRevokedDevice);
    return () => window.removeEventListener('deardiary-device-revoked', handleRevokedDevice);
  }, []);

  const handleBackNavigation = useCallback(() => {
    if (!isAuthenticated) {
      return;
    }

    if (isEditorFocusMode && activeTab === 'diaries' && currentScreen === 'entryEditor') {
      setIsEditorFocusMode(false);
      return;
    }

    if (activeTab === 'diaries') {
      if (currentScreen === 'diarySettings') {
        handleNavigate('diaries', 'diaryDetail', selectedDiaryId);
        return;
      }
      if (currentScreen === 'entryEditor') {
        if (selectedPrompt) {
          handleNavigate('home');
        } else if (selectedDiaryId) {
          handleNavigate('diaries', 'diaryDetail', selectedDiaryId);
        } else {
          handleNavigate('diaries', 'list');
        }
        return;
      }
      if (currentScreen === 'diaryDetail') {
        handleNavigate('diaries', 'list');
        return;
      }
    }

    if (activeTab === 'stats' && currentScreen === 'appSettings') {
      handleNavigate('stats', 'list');
      return;
    }

    if (activeTab !== 'home' || currentScreen !== 'list') {
      handleNavigate('home', 'list');
      return;
    }

    if (isAndroid()) {
      void exitNativeApp();
    }
  }, [activeTab, currentScreen, isAuthenticated, isEditorFocusMode, selectedDiaryId, selectedPrompt]);

  useEffect(() => addNativeBackListener(handleBackNavigation), [handleBackNavigation]);

  // Convert quick note into formal diary entry helper
  const handleConvertToDiaryEntry = async (request: NoteConversionRequest) => {
    const targetDiary = diaries.find(diary => diary.id === request.journalId);
    if (!targetDiary) return;

    await measureAsync('app.quickNote.convertToEntry', async () => {
      await diaryRepository.createEntry({
        diaryId: targetDiary.id,
        date: request.date,
        title: request.title,
        body: request.body,
        moodName: 'Reflective',
      moodEmoji: '💭',
        tags: request.tags,
        photoUris: []
      });

      if (request.disposition === 'delete') {
        await diaryRepository.deleteNote(request.noteId);
      }
    });

    showToast(`Saved to this device inside "${targetDiary.name}".`, 'success');
    handleNavigate('diaries', 'diaryDetail', targetDiary.id);
  };

  // Quick Capturing note helpers
  const handleOpenQuickNote = async (noteText: string) => {
    await measureAsync('app.quickNote.create', async () => {
      await diaryRepository.createNote({
        title: noteText.substring(0, 24) || 'Untitled quick thought',
        body: noteText,
        isPinned: false,
        tags: ['thoughts']
      });
    });
    showToast('Saved to this device.', 'success');
    handleNavigate('notes');
  };

  const handleOpenNewEntryWithPrompt = (promptText: string) => {
    const targetDiary = diaries[0];
    if (!targetDiary) return;
    
    // We navigate to entry editor in diaries tab
    handleNavigate('diaries', 'entryEditor', targetDiary.id, '', '', '', promptText);
  };

  const renderDiaryUnlockPrompt = (diary: Diary) => {
    const requiredLength = security.pinLength || 4;
    const canSubmitPin = isValidPin(diaryUnlockPin, security.pinLength);
    const canUseBiometricDiaryUnlock = isNativePlatform() && security.isBiometricsEnabled;

    return (
      <OverlayPortal>
        <motion.div
          className="fixed inset-0 z-[80] flex items-end justify-center bg-black/55 p-4 sm:items-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <motion.div
            className="flex max-h-[calc(100dvh-2rem)] w-full max-w-md flex-col gap-4 overflow-y-auto rounded-3xl border border-brand-border bg-brand-card-bg p-6 text-center shadow-2xl"
            initial={{ y: 30 }}
            animate={{ y: 0 }}
            exit={{ y: 30 }}
          >
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => handleNavigate('diaries', 'list')}
                className="flex h-9 w-9 items-center justify-center rounded-full text-brand-sage transition-all hover:bg-brand-blush-light hover:text-brand-plum active:scale-95"
                title="Back to diaries"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
              <span className="rounded-full bg-brand-pink/10 px-4 py-1.5 text-[9px] font-black uppercase tracking-[0.22em] text-brand-pink">
                Locked Diary
              </span>
            </div>

            <div className="flex flex-col items-center gap-3">
              <div className="flex h-16 w-16 items-center justify-center rounded-[24px] bg-brand-pink/10 text-brand-pink">
                <Lock className="w-7 h-7" />
              </div>
              <h2 className="break-words font-serif-diary text-[1.6rem] font-bold leading-[1.12] text-brand-plum">
                {diary.name}
              </h2>
              <p className="text-xs leading-relaxed text-brand-text-muted">
                This journal is private. Confirm your app PIN{canUseBiometricDiaryUnlock ? ' or biometric identity' : ''} to open it for this session.
              </p>
            </div>

            {canUseBiometricDiaryUnlock && (
              <button
                type="button"
                onClick={() => handleDiaryBiometricUnlock(diary)}
                disabled={isDiaryBiometricUnlocking}
                className="flex w-full items-center justify-center gap-2.5 rounded-xl border border-brand-pink/20 bg-brand-pink/10 py-3 text-xs font-bold uppercase tracking-wider text-brand-pink transition-all hover:bg-brand-pink hover:text-white disabled:opacity-50"
              >
                <Fingerprint className={`w-4 h-4 ${isDiaryBiometricUnlocking ? 'animate-pulse' : ''}`} />
                <span>{isDiaryBiometricUnlocking ? 'Checking Identity' : 'Unlock with Biometrics'}</span>
              </button>
            )}

            <form
              onSubmit={(e) => {
                e.preventDefault();
                void handleDiaryPinUnlock(diary);
              }}
              className="flex flex-col gap-4"
            >
              <label className="flex flex-col gap-2 text-left">
                <span className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-brand-sage">App Security PIN</span>
                <div className="relative">
                  <input
                    type={showDiaryUnlockPin ? 'text' : 'password'}
                    inputMode="numeric"
                    maxLength={requiredLength}
                    value={diaryUnlockPin}
                    onChange={(e) => {
                      setDiaryUnlockPin(e.target.value.replace(/\D/g, '').slice(0, requiredLength));
                      setDiaryUnlockError('');
                      setDiaryUnlockSuccess('');
                    }}
                    placeholder={`${requiredLength}-digit PIN`}
                    className="w-full rounded-2xl border border-brand-border bg-brand-bg/45 p-3.5 pr-11 text-sm text-brand-plum placeholder:text-brand-text-muted/55 focus:border-brand-sage focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowDiaryUnlockPin(prev => !prev)}
                    className="absolute inset-y-0 right-3 flex items-center text-brand-sage transition-colors hover:text-brand-pink"
                    title={showDiaryUnlockPin ? 'Hide PIN' : 'Show PIN'}
                  >
                    {showDiaryUnlockPin ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </label>

              <div className="min-h-[18px] flex items-center justify-center">
                {diaryUnlockError && (
                  <p className="flex items-center gap-1 text-[11px] font-bold text-brand-rose">
                    <AlertCircle className="w-3 h-3" />
                    <span>{diaryUnlockError}</span>
                  </p>
                )}
                {diaryUnlockSuccess && !diaryUnlockError && (
                  <p className="flex items-center gap-1 text-[11px] font-bold text-brand-sage">
                    <Check className="w-3.5 h-3.5" />
                    <span>{diaryUnlockSuccess}</span>
                  </p>
                )}
              </div>

              <button
                type="submit"
                disabled={!canSubmitPin}
                className="w-full rounded-xl bg-brand-sage py-3.5 text-xs font-extrabold uppercase tracking-wider text-white shadow-sm transition-all hover:bg-brand-sage-dark disabled:cursor-not-allowed disabled:bg-brand-sage/45 disabled:text-white/90"
              >
                Unlock Diary
              </button>
            </form>

            <div className="flex items-start justify-center gap-2 text-left text-[10px] font-semibold leading-relaxed text-brand-text-muted">
              <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-sage" />
              <span>Uses the same private app PIN configured in Security settings.</span>
            </div>
          </motion.div>
        </motion.div>
      </OverlayPortal>
    );
  };

  // Render sub-screens depending on active state
  const renderContent = () => {
    switch (activeTab) {
      case 'home':
        return (
          <HomeScreen 
            userProfile={userProfile}
            layout={layout}
            excludeDiaryIds={lockedDiaryIds}
            onNavigate={handleNavigate}
            onOpenQuickNote={handleOpenQuickNote}
            onOpenNewEntryWithPrompt={handleOpenNewEntryWithPrompt}
          />
        );

      case 'diaries':
        {
          const selectedDiary = diaries.find(d => d.id === selectedDiaryId);
          const lockedDiaryScreen = ['diaryDetail', 'diarySettings', 'entryEditor'].includes(currentScreen);
          if (selectedDiary?.isLocked && lockedDiaryScreen && !unlockedDiaryIds.has(selectedDiary.id)) {
            return renderDiaryUnlockPrompt(selectedDiary);
          }
        }

        if (currentScreen === 'diaryDetail') {
          const selectedDiary = diaries.find(d => d.id === selectedDiaryId);
          if (selectedDiary) {
            return (
              <DiaryDetailScreen 
                diary={selectedDiary}
                entryId={selectedEntryId}
                layout={layout}
                onBack={() => handleNavigate('diaries', 'list')}
                onEditEntry={(entryId) => handleNavigate('diaries', 'entryEditor', selectedDiaryId, entryId)}
                onNewEntry={(diaryId, dateStr) => handleNavigate('diaries', 'entryEditor', diaryId, '', dateStr)}
                onOpenSettings={(diaryId) => handleNavigate('diaries', 'diarySettings', diaryId)}
                onRefreshEntries={refreshEntries}
                archiveMonths={archiveMonths}
                onHydrateArchiveMonth={handleHydrateArchiveMonth}
              />
            );
          }
        }

        if (currentScreen === 'diarySettings') {
          const selectedDiary = diaries.find(d => d.id === selectedDiaryId);
          if (selectedDiary) {
            return (
              <DiarySettingsScreen 
                diary={selectedDiary}
                layout={layout}
                security={security}
                onBack={() => handleNavigate('diaries', 'diaryDetail', selectedDiaryId)}
                onRefreshDiaries={refreshDiaries}
              />
            );
          }
        }

        if (currentScreen === 'entryEditor') {
          return (
            <EntryEditorScreen 
              diaries={diaries}
              settings={settings}
              diaryId={selectedDiaryId}
              entryId={selectedEntryId}
              layout={layout}
              initialDate={selectedDate}
              initialPrompt={selectedPrompt}
              showDiarySelector={!!selectedPrompt}
              onBack={() => {
                setIsEditorFocusMode(false);
                if (selectedPrompt) {
                  handleNavigate('home');
                } else if (selectedDiaryId) {
                  handleNavigate('diaries', 'diaryDetail', selectedDiaryId);
                } else {
                  handleNavigate('diaries', 'list');
                }
              }}
              onRefreshEntries={refreshEntries}
              onFocusModeChange={setIsEditorFocusMode}
              initialFocusMode={isEditorFocusMode}
              onShowToast={showToast}
              onRunWithLoader={runWithGlobalLoader}
            />
          );
        }

        return (
          <DiariesScreen 
            diaries={diaries}
            layout={layout}
            onNavigate={handleNavigate}
            onRefreshDiaries={refreshDiaries}
          />
        );

      case 'notes':
        return (
          <NotesScreen 
            settings={settings}
            diaries={diaries}
            layout={layout}
            onConvertToDiaryEntry={handleConvertToDiaryEntry}
            initialNoteId={selectedNoteId}
            onClearInitialNoteId={() => setSelectedNoteId('')}
          />
        );

      case 'search':
        return (
          <SearchScreen 
            settings={settings}
            layout={layout}
            initialQuery={searchInitialQuery}
            excludeDiaryIds={lockedDiaryIds}
            archiveMonths={archiveMonths}
            onHydrateArchiveMonth={handleHydrateArchiveMonth}
            onHydrateAllArchiveMonths={handleHydrateAllArchiveMonths}
            onOpenSettingsSection={(section) => { setSettingsInitialSection(section); handleNavigate('stats', 'appSettings'); }}
            onNavigate={handleNavigate}
            onEditNote={(note) => {
              // Deep-link note editing from search results
              handleNavigate('notes', 'list', '', '', '', note.id);
            }}
          />
        );

      case 'stats':
        if (currentScreen === 'appSettings') {
          return (
            <AppSettingsScreen 
              initialSettings={settings}
              initialSecurity={security}
              initialProfile={userProfile}
              layout={layout}
              initialSection={settingsInitialSection}
              onBack={() => handleNavigate('stats', 'list')}
              onResetSuccess={() => {
                void reloadData();
                handleNavigate('home');
              }}
              onDataChanged={reloadData}
              onShowToast={showToast}
              onThemeChange={handleLocalThemeChange}
            />
          );
        }

        return (
          <StatsScreen 
            diaries={diaries}
            excludeDiaryIds={lockedDiaryIds}
            archiveMonths={archiveMonths}
            layout={layout}
            onNavigate={handleNavigate}
          />
        );

      default:
        return null;
    }
  };

  const renderSuspendedContent = () => (
    <Suspense fallback={<ScreenFallback />}>
      {renderContent()}
    </Suspense>
  );

  const renderSyncAuthorizationBanner = () => syncAuthorizationMessage ? (
    <div className="fixed inset-x-3 top-3 z-[91] mx-auto flex max-w-sm items-center gap-3 rounded-lg bg-brand-plum px-3 py-2 text-white shadow-lg">
      <p className="min-w-0 flex-1 text-xs font-semibold">{syncAuthorizationMessage}</p>
      <button
        type="button"
        onClick={() => void handleSyncReauthorization()}
        disabled={isReauthorizingSync}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/15 disabled:opacity-50"
        title="Reconnect encrypted sync"
      >
        <RefreshCw className={`h-4 w-4 ${isReauthorizingSync ? 'animate-spin' : ''}`} />
      </button>
    </div>
  ) : null;

  const getSyncStatusDisplay = () => {
    if (!syncStatus || syncAuthorizationMessage) return null;
    const pending = syncStatus.pendingOutboxCount;
    const failed = syncStatus.failedOperationCount;
    const label = failed > 0
      ? `${failed} sync item${failed === 1 ? '' : 's'} need attention`
      : !isOnline || syncStatus.isOffline
        ? pending > 0 ? `${pending} waiting for internet` : 'Offline'
        : pending > 0
          ? `${pending} syncing`
          : syncStatus.currentActivity || '';
    if (!label) return null;
    if (failed === 0 && pending === 0 && (!isOnline || syncStatus.isOffline)) return null;
    return {
      label,
      pending,
      failed,
      spinning: pending > 0 && failed === 0 && isOnline && !syncStatus.isOffline,
      tone: failed > 0 ? 'attention' : (!isOnline || syncStatus.isOffline) ? 'offline' : 'syncing',
    };
  };

  const renderSyncStatusBadge = (placement: 'desktop' | 'floating' = 'floating') => {
    const status = getSyncStatusDisplay();
    if (!status) return null;
    const toneClass = status.tone === 'attention'
      ? 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200'
      : status.tone === 'offline'
        ? 'border-brand-border bg-white/86 text-brand-plum dark:bg-brand-card-bg/86 dark:text-brand-text'
        : 'border-brand-border bg-white/86 text-brand-sage dark:bg-brand-card-bg/86 dark:text-brand-sage-light';
    const chip = (
      <div className={`flex min-w-0 items-center gap-2 rounded-full border px-3 py-2 text-[11px] font-extrabold shadow-sm backdrop-blur-md ${toneClass}`}>
        <RefreshCw className={`h-3.5 w-3.5 shrink-0 ${status.spinning ? 'animate-spin' : ''}`} />
        <span className="truncate">{status.label}</span>
      </div>
    );
    if (placement === 'desktop') {
      return <div className="hidden max-w-[14rem] lg:block">{chip}</div>;
    }
    return (
      <div className={`fixed left-4 z-[38] max-w-[calc(100vw-2rem)] ${currentScreen !== 'entryEditor' ? 'bottom-[calc(5.75rem+var(--safe-area-inset-bottom))]' : 'bottom-[calc(1rem+var(--safe-area-inset-bottom))]'}`}>
        {chip}
      </div>
    );
  };

  const renderToast = () => (
    <AnimatePresence>
      {toast && (
        <motion.div
          initial={{ opacity: 0, y: -40, scale: 0.92, x: '-50%' }}
          animate={{ opacity: 1, y: 0, scale: 1, x: '-50%' }}
          exit={{ opacity: 0, y: -15, scale: 0.95, x: '-50%' }}
          transition={{ type: "spring", stiffness: 350, damping: 25 }}
          className="fixed top-6 left-1/2 z-50 flex items-center gap-3 bg-white/95 dark:bg-brand-card-bg/95 backdrop-blur-md px-5 py-3.5 rounded-2xl border border-brand-border/80 shadow-2xl max-w-sm w-[90%] select-none pointer-events-auto toast-safe"
        >
          <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 animate-pulse ${
            toast.type === 'success' ? 'bg-brand-sage' :
            toast.type === 'error' ? 'bg-brand-rose' : 'bg-brand-pink'
          }`} />

          <p className="text-xs font-bold text-brand-plum leading-snug flex-grow">
            {toast.message}
          </p>

          <button
            onClick={() => setToast(null)}
            className="text-brand-text-muted hover:text-brand-rose transition-colors p-1 rounded-lg hover:bg-brand-blush-light dark:hover:bg-brand-blush-light/10"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );

  const desktopPageTitle = () => {
    if (activeTab === 'stats' && currentScreen === 'appSettings') return 'Settings';
    if (activeTab === 'stats') return 'Insights';
    if (activeTab === 'diaries' && currentScreen === 'entryEditor') return selectedEntryId ? 'Edit Entry' : 'New Entry';
    if (activeTab === 'diaries' && currentScreen === 'diaryDetail') {
      return diaries.find(diary => diary.id === selectedDiaryId)?.name || 'My Journal';
    }
    return {
      home: 'Today',
      diaries: 'Journals',
      notes: 'Notes',
      search: 'Search',
    }[activeTab] || 'Dear Diary';
  };

  const renderDesktopBackground = () => (
    <div className="fixed inset-0 z-0 pointer-events-none">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(255,255,255,0.74),transparent_42%)] dark:bg-[radial-gradient(circle_at_50%_0%,rgba(255,255,255,0.05),transparent_40%)]" />
      <div className="absolute left-[15rem] top-[-18rem] h-[38rem] w-[38rem] rounded-full bg-brand-blush-dark/28 blur-[150px]" />
      <div className="absolute bottom-[-16rem] right-[-10rem] h-[34rem] w-[34rem] rounded-full bg-brand-sage-light/28 blur-[145px]" />
    </div>
  );

  const renderDesktopShell = () => {
    const navItems = [
      { id: 'home', label: 'Today', icon: Home, onClick: () => handleNavigate('home'), active: activeTab === 'home' },
      { id: 'diaries', label: 'Journals', icon: BookOpen, onClick: () => handleNavigate('diaries'), active: activeTab === 'diaries' },
      { id: 'notes', label: 'Notes', icon: ClipboardList, onClick: () => handleNavigate('notes'), active: activeTab === 'notes' },
      { id: 'stats', label: 'Insights', icon: BarChart2, onClick: () => handleNavigate('stats'), active: activeTab === 'stats' && currentScreen !== 'appSettings' },
    ];

    return (
      <div className="min-h-screen bg-brand-bg text-brand-text font-sans select-none relative safe-area-root overflow-hidden">
        {renderSyncAuthorizationBanner()}
        <GlobalLoaderOverlay loading={globalLoading} />
        {renderDesktopBackground()}
        {!isOnline && (
          <div className="pointer-events-none fixed inset-x-3 top-3 z-[90] mx-auto flex max-w-sm items-center justify-center gap-2 rounded-lg bg-brand-plum px-3 py-2 text-xs font-bold text-white shadow-lg" role="status">
            <WifiOff className="h-4 w-4" />
            <span>Offline. Synced changes are paused.</span>
          </div>
        )}

        <div className="relative z-10 flex h-screen min-h-0">
          <aside className="flex h-screen w-[232px] shrink-0 flex-col border-r border-brand-border/70 bg-gradient-to-b from-brand-blush-light/78 via-brand-blush-light/48 to-white/35 px-4 py-5 shadow-[18px_0_70px_rgba(62,36,41,0.06)] backdrop-blur-xl dark:from-brand-card-bg/78 dark:via-brand-card-bg/55 dark:to-brand-bg/45 xl:w-72 xl:px-6 xl:py-7">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-brand-border bg-white text-brand-sage shadow-sm dark:bg-brand-bg/40 xl:h-12 xl:w-12">
                <BookOpen className="h-5 w-5 xl:h-6 xl:w-6" />
              </div>
              <div className="min-w-0">
                <h1 className="font-serif-diary text-2xl font-bold tracking-tight text-brand-plum dark:text-brand-text xl:text-3xl">Dear Diary</h1>
                <p className="mt-0.5 text-xs font-semibold text-brand-text-muted">{visibleStreak} Day Streak</p>
              </div>
            </div>

            <nav className="mt-9 flex flex-col gap-1.5 xl:mt-14 xl:gap-2">
              {navItems.map(item => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    type="button"
                    data-testid={`nav-${item.id}`}
                    onClick={item.onClick}
                    className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-bold transition-all xl:gap-4 xl:rounded-2xl xl:px-4 xl:py-3 ${
                      item.active
                        ? 'bg-white/86 text-brand-plum shadow-[0_10px_28px_rgba(62,36,41,0.08)] ring-1 ring-brand-border/75 dark:bg-white/10 dark:text-brand-text'
                        : 'text-brand-plum/72 hover:bg-white/55 hover:text-brand-plum dark:text-brand-text/75 dark:hover:bg-white/5'
                    }`}
                  >
                    <Icon className={`h-5 w-5 ${item.active ? 'text-brand-sage' : 'text-brand-plum/75 dark:text-brand-text/70'}`} />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>

            <div className="mt-auto flex flex-col gap-4">
              <div className="hidden rounded-2xl border border-brand-border/70 bg-white/62 p-4 shadow-sm dark:bg-white/5 xl:block">
                <p className="text-[10px] font-extrabold uppercase tracking-[0.2em] text-brand-sage">Private Vault</p>
                <p className="mt-2 text-xs leading-relaxed text-brand-text-muted">Local-first, encrypted sync aware, and ready to lock instantly.</p>
              </div>
              <button type="button" onClick={() => handleNavigate('stats', 'appSettings')} className="flex min-h-11 w-full items-center gap-3 rounded-xl px-4 text-sm font-bold text-brand-plum hover:bg-white/60 dark:text-brand-text dark:hover:bg-white/5">
                <ShieldCheck className="h-5 w-5" /> Settings
              </button>
              <button
                type="button"
                data-testid="lock-app-button"
                onClick={handleLockApp}
                className="flex w-full items-center justify-center gap-2 rounded-2xl bg-brand-sage px-5 py-3 text-sm font-bold text-white shadow-sm transition-all hover:bg-brand-sage-dark active:scale-[0.99]"
              >
                <Lock className="h-4 w-4" />
                Lock
              </button>
            </div>
          </aside>

          <section className="flex min-w-0 flex-1 flex-col">
            <header className="flex h-16 shrink-0 items-center justify-between border-b border-brand-border/55 bg-brand-bg/78 px-5 backdrop-blur-2xl dark:bg-brand-bg/70 xl:h-20 xl:px-10">
              <div className="min-w-0">
                <p className="text-[10px] font-extrabold uppercase tracking-[0.22em] text-brand-sage">Dear Diary</p>
                <h2 className="truncate font-serif-diary text-xl font-bold tracking-tight text-brand-plum dark:text-brand-text xl:text-2xl">{desktopPageTitle()}</h2>
              </div>

              <div className="flex min-w-0 items-center gap-3 xl:gap-4">
                {renderSyncStatusBadge('desktop')}
                <form onSubmit={handleDesktopSearchSubmit} className="relative hidden w-[18rem] max-w-[30vw] lg:block xl:w-[28rem] xl:max-w-[36vw]">
                  <Search className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-brand-text-muted" />
                  <input
                    type="text"
                    data-testid="nav-search"
                    aria-label="Global search"
                    value={desktopSearchQuery}
                    onChange={(event) => setDesktopSearchQuery(event.target.value)}
                    placeholder="Search thoughts, memories, dreams"
                    className="w-full rounded-full border border-brand-border/60 bg-white/68 py-2.5 pl-11 pr-4 text-sm font-semibold text-brand-plum placeholder:text-brand-text-muted/55 outline-none transition-all focus:border-brand-sage focus:bg-white focus:shadow-[0_8px_30px_rgba(62,36,41,0.08)] dark:bg-white/5 dark:text-brand-text xl:py-3"
                  />
                </form>
                <button
                  type="button"
                  data-testid="new-entry-button"
                  onClick={handleDesktopNewEntry}
                  className="inline-flex items-center gap-2 rounded-full bg-brand-sage px-4 py-2.5 text-sm font-bold text-white shadow-sm transition-all hover:bg-brand-sage-dark active:scale-[0.98] xl:px-5 xl:py-3"
                >
                  <Plus className="h-4 w-4" />
                  <span className="hidden xl:inline">New Entry</span>
                  <span className="xl:hidden">New</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleNavigate('stats', 'appSettings')}
                  className="relative flex h-10 w-10 items-center justify-center overflow-hidden rounded-full border border-brand-border bg-white text-xl shadow-sm transition-transform hover:scale-105 dark:bg-brand-card-bg xl:h-12 xl:w-12"
                  style={{ backgroundColor: userProfile.avatarColor }}
                  title="Open settings"
                >
                  <ProfileAvatar profile={userProfile} />
                </button>
              </div>
            </header>

            <main className="min-h-0 flex-1 overflow-y-auto px-5 py-5 xl:px-10 xl:py-7">
              <AnimatePresence mode="wait">
                <motion.div
                  key={`${activeTab}-${currentScreen}`}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.22 }}
                  className="mx-auto w-full max-w-[1280px] 2xl:max-w-[1460px]"
                >
                  {renderSuspendedContent()}
                </motion.div>
              </AnimatePresence>
            </main>
          </section>
        </div>
        {renderToast()}
      </div>
    );
  };

  const renderDesktopEditorShell = () => (
    <div className="min-h-screen bg-brand-bg text-brand-text font-sans select-none relative safe-area-root overflow-x-hidden">
      {renderSyncAuthorizationBanner()}
      {renderSyncStatusBadge()}
      <GlobalLoaderOverlay loading={globalLoading} />
      {renderDesktopBackground()}
      {!isOnline && (
        <div className="pointer-events-none fixed inset-x-3 top-3 z-[90] mx-auto flex max-w-sm items-center justify-center gap-2 rounded-lg bg-brand-plum px-3 py-2 text-xs font-bold text-white shadow-lg" role="status">
          <WifiOff className="h-4 w-4" />
          <span>Offline. Synced changes are paused.</span>
        </div>
      )}
      <main className="relative z-10 mx-auto min-h-screen w-full max-w-[1500px] px-5 py-5 xl:px-8 xl:py-8">
        {renderSuspendedContent()}
      </main>
      {renderToast()}
    </div>
  );

  // If locked, return LockScreen view
  if (!isAuthenticated) {
    return (
      <>
        <Suspense fallback={<ScreenFallback />}>
          <LockScreen
            initialSecurity={security}
            initialSettings={settings}
            onSecurityChange={setSecurity}
            onSettingsChange={handleLockSettingsChange}
            onThemeChange={handleLocalThemeChange}
            onUnlock={handleUnlock}
          />
        </Suspense>
        <GlobalLoaderOverlay loading={globalLoading} />
      </>
    );
  }

  // If in editor focus mode, render only the editor at root level (bypasses transformed motion.div containers and options dock)
  if (isEditorFocusMode && activeTab === 'diaries' && currentScreen === 'entryEditor') {
    return (
      <div className="min-h-screen bg-brand-bg text-brand-text flex flex-col font-sans select-none relative safe-area-root">
        {renderSyncAuthorizationBanner()}
        {renderSyncStatusBadge()}
        <GlobalLoaderOverlay loading={globalLoading} />
        {!isOnline && (
          <div className="pointer-events-none fixed inset-x-3 top-3 z-[90] mx-auto flex max-w-sm items-center justify-center gap-2 rounded-lg bg-brand-plum px-3 py-2 text-xs font-bold text-white shadow-lg" role="status">
            <WifiOff className="h-4 w-4" />
            <span>Offline. Synced changes are paused.</span>
          </div>
        )}
        {/* Background Soft Ambient Light Blurs */}
        <div className="fixed inset-0 z-0 pointer-events-none opacity-20">
          <div className="absolute top-[-10%] left-[-10%] w-[60%] h-[60%] rounded-full bg-brand-blush-dark blur-[120px]" />
          <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] rounded-full bg-brand-sage-light blur-[100px]" />
        </div>
        <div className="z-10 flex-grow flex flex-col">
          {renderSuspendedContent()}
        </div>
        {renderToast()}
      </div>
    );
  }

  if (isDesktop && activeTab === 'diaries' && currentScreen === 'entryEditor') {
    return renderDesktopEditorShell();
  }

  if (isDesktop) {
    return renderDesktopShell();
  }

  return (
    <div className="tablet-shell-content min-h-screen bg-brand-bg text-brand-text flex flex-col items-center overflow-x-hidden font-sans select-none pb-24 relative safe-area-root app-shell">
      {renderSyncAuthorizationBanner()}
      {renderSyncStatusBadge()}
      <GlobalLoaderOverlay loading={globalLoading} />
      {layout === 'tablet' && (
        <NavigationRail
          active={activeTab}
          onNavigate={(destination) => handleNavigate(destination)}
          onCreate={() => setIsCreateSheetOpen(true)}
          onSearch={() => handleNavigate('search')}
          onSettings={() => handleNavigate('stats', 'appSettings')}
          onLock={handleLockApp}
        />
      )}
      {!isOnline && (
        <div className="pointer-events-none fixed inset-x-3 top-3 z-[90] mx-auto flex max-w-sm items-center justify-center gap-2 rounded-lg bg-brand-plum px-3 py-2 text-xs font-bold text-white shadow-lg" role="status">
          <WifiOff className="h-4 w-4" />
          <span>Offline. Synced changes are paused.</span>
        </div>
      )}
      
      {/* Background Soft Ambient Light Blurs */}
      <div className="fixed inset-0 z-0 pointer-events-none opacity-20">
        <div className="absolute top-[-10%] left-[-10%] w-[60%] h-[60%] rounded-full bg-brand-blush-dark blur-[120px]" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] rounded-full bg-brand-sage-light blur-[100px]" />
      </div>

      {/* Main Container */}
      <main className="w-full max-w-lg z-10 px-4 pt-1 pb-6 flex-grow flex flex-col justify-between app-main">
        {currentScreen === 'list' && (
          <AppHeader
            title={rootPageTitle()}
            profile={userProfile}
            onSearch={() => handleNavigate('search')}
            onProfile={() => setIsProfileSheetOpen(true)}
          />
        )}
        <AnimatePresence mode="wait">
          <motion.div
            key={`${activeTab}-${currentScreen}`}
            initial={{ opacity: 0, x: 10 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -10 }}
            transition={{ duration: 0.25 }}
            className="flex-grow flex flex-col justify-start"
          >
            {renderSuspendedContent()}
          </motion.div>
        </AnimatePresence>
      </main>

      {layout === 'mobile' && currentScreen !== 'entryEditor' && (
        <MobileBottomNavigation active={activeTab} onNavigate={(destination) => handleNavigate(destination)} onCreate={() => setIsCreateSheetOpen(true)} />
      )}

      <CreateActionSheet
        open={isCreateSheetOpen}
        hasJournals={diaries.length > 0}
        onClose={() => setIsCreateSheetOpen(false)}
        onNewEntry={() => handleCreateEntry()}
        onNewNote={() => handleNavigate('notes')}
        onVoice={() => handleCreateEntry('voice')}
        onPhoto={() => handleCreateEntry('photo')}
        onNewJournal={() => handleNavigate('diaries')}
      />
      <ProfileActionSheet
        open={isProfileSheetOpen}
        profile={userProfile}
        onClose={() => setIsProfileSheetOpen(false)}
        onSettings={() => handleNavigate('stats', 'appSettings')}
        onLock={handleLockApp}
      />

      {renderToast()}
    </div>
  );
}
