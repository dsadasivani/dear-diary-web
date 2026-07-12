import { useCallback, useEffect, useState } from 'react';
import { BookOpen, RefreshCw } from 'lucide-react';
import type { AppSettings, LocalSyncAccountState, SecurityConfig, UserProfile } from './types';
import { diaryRepository } from './repositories';
import { hydrateNativeUiPreferences } from './mobile/nativeStorageBridge';
import { migrateLegacyDataUriMedia } from './mobile/legacyMediaMigration';
import { initializeMediaGarbageCollection } from './mobile/mediaGarbageCollector';
import App from './App';
import { isWeb } from './platform';
import WebCompanionLink from './components/WebCompanionLink';
import { measureAsync } from './utils/performance';

interface BootstrapData {
  settings: AppSettings;
  security: SecurityConfig;
  userProfile: UserProfile;
  syncAccount: LocalSyncAccountState | null;
}

let bootstrapPromise: Promise<BootstrapData> | null = null;

const loadBootstrapData = (): Promise<BootstrapData> => {
  if (!bootstrapPromise) {
    bootstrapPromise = measureAsync('app.bootstrap', async () => {
      await hydrateNativeUiPreferences();
      await diaryRepository.initialize();
      await seedE2eRepositoryIfRequested();
      await migrateLegacyDataUriMedia().catch(error => {
        console.warn('Legacy media migration will be retried on the next launch:', error);
      });
      initializeMediaGarbageCollection();
      const [settings, security, userProfile, syncAccount] = await Promise.all([
        diaryRepository.getSettings(),
        diaryRepository.getSecurityConfig(),
        diaryRepository.getUserProfile(),
        diaryRepository.getLocalSyncAccountState(),
      ]);
      return { settings, security, userProfile, syncAccount };
    });
  }
  return bootstrapPromise;
};

const shouldSeedE2eRepository = (): boolean => {
  if (import.meta.env.VITE_DEAR_DIARY_E2E !== '1') return false;
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).has('e2eApp');
};

const seedE2eRepositoryIfRequested = async (): Promise<void> => {
  if (!shouldSeedE2eRepository()) return;
  const existingSyncAccount = await diaryRepository.getLocalSyncAccountState();
  if (!existingSyncAccount) {
    await diaryRepository.saveLocalSyncAccountState({
      accountId: 'e2e-account',
      deviceId: 'e2e-device',
      deviceRole: 'primary_mobile',
      googleUserId: 'e2e-google-user',
      googleEmail: 'e2e@example.test',
      devicePublicKey: 'e2e-public-key',
      recoveryKeyDriveFileId: 'e2e-recovery-key',
      latestSnapshotDriveFileId: 'e2e-snapshot',
      currentSyncSequence: 0,
      keyEpoch: 1,
      linkedAt: 1,
    });
  }

  const diaries = await diaryRepository.listDiaries();
  let openDiary = diaries.find(diary => diary.name === 'E2E Open Diary');
  let lockedDiary = diaries.find(diary => diary.name === 'E2E Locked Diary');
  if (!openDiary) {
    openDiary = await diaryRepository.createDiary({
      name: 'E2E Open Diary',
      emoji: 'O',
      color: '#4C6A58',
      isLocked: false,
    });
  }
  if (!lockedDiary) {
    lockedDiary = await diaryRepository.createDiary({
      name: 'E2E Locked Diary',
      emoji: 'L',
      color: '#8A3D55',
      isLocked: true,
    });
  }

  const entries = await diaryRepository.listEntries();
  if (!entries.some(entry => entry.title === 'E2E Public Picnic')) {
    await diaryRepository.createEntry({
      diaryId: openDiary.id,
      date: '2026-07-10',
      title: 'E2E Public Picnic',
      body: '<p>ordinary visible memory</p>',
      moodName: 'Calm',
      moodEmoji: '',
      tags: ['shared'],
      photoUris: [],
    });
  }
  if (!entries.some(entry => entry.title === 'E2E Private Keyword')) {
    await diaryRepository.createEntry({
      diaryId: lockedDiary.id,
      date: '2026-07-11',
      title: 'E2E Private Keyword',
      body: '<p>secret locked diary body</p>',
      moodName: 'Calm',
      moodEmoji: '',
      tags: ['private'],
      photoUris: [],
    });
  }
  if (!entries.some(entry => entry.title === 'E2E Sanitizer Probe')) {
    await diaryRepository.createEntry({
      diaryId: openDiary.id,
      date: '2026-07-09',
      title: 'E2E Sanitizer Probe',
      body: '<p>sanitized visible marker</p><img src=x onerror="window.__e2eXss=1"><script>window.__e2eXss=1</script><iframe srcdoc="<script>window.__e2eXss=1</script>"></iframe>',
      moodName: 'Calm',
      moodEmoji: '',
      tags: ['shared'],
      photoUris: [],
    });
  }

  const notes = await diaryRepository.listNotes();
  if (!notes.some(note => note.title === 'E2E Quick Note')) {
    await diaryRepository.createNote({
      title: 'E2E Quick Note',
      body: '<p>plain quick note</p>',
      isPinned: true,
      tags: ['shared'],
    });
  }
  if (!notes.some(note => note.title === 'E2E Sanitized Note')) {
    await diaryRepository.createNote({
      title: 'E2E Sanitized Note',
      body: '<p>safe note marker</p><object data="javascript:alert(1)">bad</object><svg><script>window.__e2eXss=1</script></svg>',
      isPinned: false,
      tags: ['shared'],
    });
  }

  const archiveState = await diaryRepository.getPartitionHydrationState('month:2021-03');
  if (archiveState.status === 'not_available') {
    await diaryRepository.markPartitionAvailable('month:2021-03', 4);
  }
};

export default function AppBootstrap() {
  const [data, setData] = useState<BootstrapData | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  const handleCompanionLinked = useCallback(async (linkedSyncAccount?: LocalSyncAccountState) => {
    bootstrapPromise = null;
    const [settings, security, userProfile, syncAccount] = await Promise.all([
      diaryRepository.getSettings(),
      diaryRepository.getSecurityConfig(),
      diaryRepository.getUserProfile(),
      diaryRepository.getLocalSyncAccountState(),
    ]);
    setData({ settings, security, userProfile, syncAccount: syncAccount || linkedSyncAccount || null });
  }, []);

  useEffect(() => {
    let active = true;
    setError('');
    loadBootstrapData()
      .then(result => {
        if (active) setData(result);
      })
      .catch(bootstrapError => {
        bootstrapPromise = null;
        if (active) setError(bootstrapError?.message || 'Local storage could not be opened.');
      });
    return () => {
      active = false;
    };
  }, [attempt]);

  if (data) {
    if (isWeb() && !data.syncAccount) {
      return <WebCompanionLink onLinked={handleCompanionLinked} />;
    }
    return (
      <App
        initialSettings={data.settings}
        initialSecurity={data.security}
        initialUserProfile={data.userProfile}
      />
    );
  }

  return (
    <div className="min-h-screen min-h-[100dvh] bg-brand-bg flex flex-col items-center justify-center gap-5 px-6 text-center">
      <div className="w-16 h-16 rounded-3xl bg-brand-pink/10 text-brand-pink flex items-center justify-center shadow-sm">
        <BookOpen className="w-7 h-7" />
      </div>
      <h1 className="font-serif-diary text-2xl font-bold text-brand-plum">Dear Diary</h1>
      {error ? (
        <div className="flex flex-col items-center gap-3 max-w-xs">
          <p className="text-xs text-brand-pink-dark">{error}</p>
          <button
            type="button"
            onClick={() => setAttempt(value => value + 1)}
            className="w-10 h-10 rounded-full bg-brand-sage text-white flex items-center justify-center shadow-sm"
            title="Retry local storage"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      ) : (
        <div className="w-8 h-8 rounded-full border-2 border-brand-rose-light border-t-brand-pink animate-spin" />
      )}
    </div>
  );
}
