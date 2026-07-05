import { useEffect, useState } from 'react';
import { BookOpen, RefreshCw } from 'lucide-react';
import type { AppSettings, SecurityConfig, UserProfile } from './types';
import { diaryRepository } from './repositories';
import { hydrateNativeUiPreferences } from './mobile/nativeStorageBridge';
import { migrateLegacyDataUriMedia } from './mobile/legacyMediaMigration';
import { backupCoordinator } from './utils/backupCoordinator';
import App from './App';

interface BootstrapData {
  settings: AppSettings;
  security: SecurityConfig;
  userProfile: UserProfile;
}

let bootstrapPromise: Promise<BootstrapData> | null = null;

const loadBootstrapData = (): Promise<BootstrapData> => {
  if (!bootstrapPromise) {
    bootstrapPromise = (async () => {
      await hydrateNativeUiPreferences();
      await diaryRepository.initialize();
      await migrateLegacyDataUriMedia().catch(error => {
        console.warn('Legacy media migration will be retried on the next launch:', error);
      });
      await backupCoordinator.initialize();
      const [settings, security, userProfile] = await Promise.all([
        diaryRepository.getSettings(),
        diaryRepository.getSecurityConfig(),
        diaryRepository.getUserProfile(),
      ]);
      return { settings, security, userProfile };
    })();
  }
  return bootstrapPromise;
};

export default function AppBootstrap() {
  const [data, setData] = useState<BootstrapData | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

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
