import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, GoogleAccountSession, SecurityConfig, SupabaseAuthSession, SyncAccount } from '../types';
import LockScreen from './LockScreen';

const mocks = vi.hoisted(() => ({
  getLocalSyncAccountState: vi.fn(),
  getSecurityConfig: vi.fn(),
  saveSecurityConfig: vi.fn(),
  startGoogleAuth: vi.fn(),
  exchangeGoogleIdTokenForSupabaseSession: vi.fn(),
  createConfiguredSupabaseControlPlaneClient: vi.fn(),
  bootstrapNewMobileAccount: vi.fn(),
  applyThemePreference: vi.fn(),
  getLocalThemePreference: vi.fn(),
  setLocalThemePreference: vi.fn(),
  createInitialPinWithRecovery: vi.fn(),
}));

vi.mock('../repositories', () => ({
  diaryRepository: {
    getLocalSyncAccountState: mocks.getLocalSyncAccountState,
    getSecurityConfig: mocks.getSecurityConfig,
    saveSecurityConfig: mocks.saveSecurityConfig,
  },
}));

vi.mock('../utils/googleAuth', () => ({
  signOutGoogleAuth: vi.fn(),
  startGoogleAuth: mocks.startGoogleAuth,
}));

vi.mock('../utils/themePreference', () => ({
  applyThemePreference: mocks.applyThemePreference,
  getLocalThemePreference: mocks.getLocalThemePreference,
  setLocalThemePreference: mocks.setLocalThemePreference,
}));

vi.mock('../sync/config', () => ({
  createConfiguredSupabaseControlPlaneClient: mocks.createConfiguredSupabaseControlPlaneClient,
  getConfiguredSupabaseAnonKey: () => 'anon-key',
  getConfiguredSupabaseUrl: () => 'https://supabase.test',
}));

vi.mock('../sync/supabaseAuth', () => ({
  exchangeGoogleIdTokenForSupabaseSession: mocks.exchangeGoogleIdTokenForSupabaseSession,
}));

vi.mock('../sync/accountBootstrap', () => ({
  bootstrapNewMobileAccount: mocks.bootstrapNewMobileAccount,
}));

vi.mock('../domain/security', async () => {
  const actual = await vi.importActual<typeof import('../domain/security')>('../domain/security');
  return {
    ...actual,
    createInitialPinWithRecovery: mocks.createInitialPinWithRecovery,
  };
});

const initialSettings: AppSettings = {
  remindersEnabled: false,
  reminderTime: '08:00 PM',
  theme: 'light',
};

const initialSecurity: SecurityConfig = {
  isPinCreated: false,
  pinHash: '',
  pinSalt: '',
  isBiometricsEnabled: false,
  isLocked: true,
};

const savedSecurity: SecurityConfig = {
  ...initialSecurity,
  isPinCreated: true,
  pinHash: 'hash',
  pinSalt: 'salt',
  isLocked: false,
  recoveryQuestionId: 'first-pet',
  recoveryAnswerHash: 'answer-hash',
  recoveryAnswerSalt: 'answer-salt',
  recoveryAnswerIterations: 310_000,
};

const googleSession: GoogleAccountSession = {
  userId: 'google-1',
  email: 'writer@example.com',
  displayName: 'Writer',
  accessToken: 'drive-token',
  idToken: 'google-id-token',
};

const supabaseSession: SupabaseAuthSession = {
  accessToken: 'supabase-token',
  refreshToken: 'refresh-token',
  expiresAt: 2_000_000_000,
};

const existingAccount: SyncAccount = {
  id: 'account-1',
  googleUserId: 'google-1',
  googleEmail: 'writer@example.com',
  createdAt: '',
  activePrimaryDeviceId: 'primary-1',
  currentSyncSequence: 4,
  currentSnapshotSequence: 4,
  currentKeyEpoch: 1,
  recoveryConfigured: true,
};

const renderLockScreen = () => render(
  <LockScreen
    initialSettings={initialSettings}
    initialSecurity={initialSecurity}
    onSecurityChange={vi.fn()}
    onUnlock={vi.fn()}
  />,
);

const clickPin = async (user: ReturnType<typeof userEvent.setup>, value: string) => {
  for (const digit of value) {
    await user.click(screen.getByRole('button', { name: new RegExp(`^${digit}$`) }));
  }
};

const finishLocalSetup = async (user: ReturnType<typeof userEvent.setup>) => {
  await clickPin(user, '1234');
  await user.click(screen.getByRole('button', { name: /continue/i }));
  await clickPin(user, '1234');
  await user.click(screen.getByRole('button', { name: /confirm pin/i }));
  await user.type(screen.getByPlaceholderText(/memorable answer/i), 'Blue');
  await user.click(screen.getByRole('button', { name: /save recovery question/i }));
  await screen.findByRole('button', { name: /connect google account/i });
};

describe('LockScreen first-run sync setup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation(query => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    mocks.getLocalThemePreference.mockReturnValue('light');
    mocks.getLocalSyncAccountState.mockResolvedValue(null);
    mocks.getSecurityConfig.mockResolvedValue(savedSecurity);
    mocks.saveSecurityConfig.mockResolvedValue(undefined);
    mocks.createInitialPinWithRecovery.mockReturnValue(savedSecurity);
    mocks.startGoogleAuth.mockResolvedValue(googleSession);
    mocks.exchangeGoogleIdTokenForSupabaseSession.mockResolvedValue(supabaseSession);
    mocks.bootstrapNewMobileAccount.mockResolvedValue({
      mode: 'created',
      localState: {},
      supabaseAccountId: 'account-1',
      primaryDeviceId: 'primary-1',
    });
    mocks.createConfiguredSupabaseControlPlaneClient.mockReturnValue({
      lookupCurrentGoogleAccount: vi.fn().mockResolvedValue(null),
    });
  });

  it('connects Google before asking new users to create an 8 digit passphrase', async () => {
    const user = userEvent.setup();
    renderLockScreen();
    await finishLocalSetup(user);

    expect(screen.queryByLabelText(/new 8-digit recovery passphrase/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /connect google account/i }));

    await screen.findByText(/No encrypted account found/i);
    const createButton = screen.getByRole('button', { name: /create encrypted account/i });
    expect(createButton).toBeDisabled();

    await user.type(screen.getByLabelText(/new 8-digit recovery passphrase/i), '1234567');
    await user.type(screen.getByLabelText(/confirm 8-digit passphrase/i), '1234567');
    expect(createButton).toBeDisabled();

    await user.clear(screen.getByLabelText(/new 8-digit recovery passphrase/i));
    await user.clear(screen.getByLabelText(/confirm 8-digit passphrase/i));
    await user.type(screen.getByLabelText(/new 8-digit recovery passphrase/i), '12345678');
    await user.type(screen.getByLabelText(/confirm 8-digit passphrase/i), '12345678');
    expect(createButton).toBeEnabled();

    await user.click(createButton);

    await waitFor(() => expect(mocks.bootstrapNewMobileAccount).toHaveBeenCalledWith(expect.objectContaining({
      accountMode: 'create',
      preflightAccount: null,
      recoveryPassphrase: '12345678',
      googleSession,
      supabaseSession,
    })));
  });

  it('asks existing users for their earlier recovery passphrase after Google lookup', async () => {
    mocks.createConfiguredSupabaseControlPlaneClient.mockReturnValue({
      lookupCurrentGoogleAccount: vi.fn().mockResolvedValue(existingAccount),
    });
    mocks.bootstrapNewMobileAccount.mockResolvedValue({
      mode: 'recovered',
      localState: {},
      supabaseAccountId: existingAccount.id,
      primaryDeviceId: 'primary-2',
    });
    const user = userEvent.setup();
    renderLockScreen();
    await finishLocalSetup(user);

    await user.click(screen.getByRole('button', { name: /connect google account/i }));

    await screen.findByText(/Encrypted account found/i);
    expect(screen.getByLabelText(/existing recovery passphrase/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/confirm 8-digit passphrase/i)).not.toBeInTheDocument();

    await user.type(screen.getByLabelText(/existing recovery passphrase/i), 'correct horse diary staple');
    await user.click(screen.getByRole('button', { name: /restore encrypted account/i }));

    await waitFor(() => expect(mocks.bootstrapNewMobileAccount).toHaveBeenCalledWith(expect.objectContaining({
      accountMode: 'recover',
      preflightAccount: existingAccount,
      recoveryPassphrase: 'correct horse diary staple',
      googleSession,
      supabaseSession,
    })));
  });
});
