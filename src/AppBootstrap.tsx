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
import { seedE2eRepositoryIfRequested } from './testing/e2eRepositorySeed';
import { AppButton, LoadingSkeleton, StatusNotice } from './components/UiPrimitives';

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
      await migrateLegacyDataUriMedia().catch((error) => {
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
    setData({
      settings,
      security,
      userProfile,
      syncAccount: syncAccount || linkedSyncAccount || null,
    });
  }, []);

  useEffect(() => {
    let active = true;
    setError('');
    loadBootstrapData()
      .then((result) => {
        if (active) setData(result);
      })
      .catch(() => {
        bootstrapPromise = null;
        if (active) setError('Dear Diary could not open local storage safely.');
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
    <main className="app-canvas flex min-h-screen min-h-[100dvh] items-center justify-center px-6 py-10 text-center">
      <section className="w-full max-w-sm" aria-labelledby="bootstrap-title">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-[1.35rem] bg-accent text-[var(--color-on-primary)] shadow-[var(--shadow-floating)]">
          <BookOpen aria-hidden="true" className="h-7 w-7" />
        </div>
        <p className="app-eyebrow mt-6">Living memories</p>
        <h1 id="bootstrap-title" className="type-page-title mt-1 font-semibold">
          Dear Diary
        </h1>
        <p className="type-supporting mx-auto mt-2 max-w-xs">
          Preparing your private sanctuary on this device.
        </p>
        <div className="mt-7">
          {error ? (
            <div className="grid gap-4">
              <StatusNotice tone="danger" role="alert">
                {error} Your memories have not been changed.
              </StatusNotice>
              <AppButton
                tone="primary"
                onClick={() => setAttempt((value) => value + 1)}
                className="w-full"
              >
                <RefreshCw aria-hidden="true" className="h-4 w-4" />
                Try again
              </AppButton>
            </div>
          ) : (
            <LoadingSkeleton lines={3} label="Opening Dear Diary" className="mx-auto max-w-xs" />
          )}
        </div>
      </section>
    </main>
  );
}
