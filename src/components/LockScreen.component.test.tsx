import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CryptoJS from 'crypto-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, GoogleAccountSession, SecurityConfig, SupabaseAuthSession } from '../types';
import LockScreen from './LockScreen';

const mocks = vi.hoisted(() => ({
  getLocalSyncAccountState: vi.fn(),
  getSecurityConfig: vi.fn(),
  saveSecurityConfig: vi.fn(),
  startGoogleAuth: vi.fn(),
  exchangeGoogleIdTokenForSupabaseSession: vi.fn(),
  hasExistingPrimaryAccount: vi.fn(),
  createPrimaryAccount: vi.fn(),
  recoverPrimaryAccount: vi.fn(),
  applyThemePreference: vi.fn(),
  getLocalThemePreference: vi.fn(),
  setLocalThemePreference: vi.fn(),
  createInitialPin: vi.fn(),
  createInitialPinWithRecovery: vi.fn(),
}));

vi.mock('../repositories', () => ({
  diaryRepository: {
    getLocalSyncAccountState: mocks.getLocalSyncAccountState,
    getSecurityConfig: mocks.getSecurityConfig,
    saveSecurityConfig: mocks.saveSecurityConfig,
  },
  syncV2Application: {
    hasExistingPrimaryAccount: mocks.hasExistingPrimaryAccount,
    createPrimaryAccount: mocks.createPrimaryAccount,
    recoverPrimaryAccount: mocks.recoverPrimaryAccount,
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
  getConfiguredSupabaseAnonKey: () => 'anon-key',
  getConfiguredSupabaseUrl: () => 'https://supabase.test',
}));

vi.mock('../sync/supabaseAuth', () => ({
  exchangeGoogleIdTokenForSupabaseSession: mocks.exchangeGoogleIdTokenForSupabaseSession,
}));

vi.mock('../domain/security', async () => {
  const actual = await vi.importActual<typeof import('../domain/security')>('../domain/security');
  return {
    ...actual,
    createInitialPin: mocks.createInitialPin,
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

const pinOnlySecurity: SecurityConfig = {
  ...initialSecurity,
  isPinCreated: true,
  pinHash: 'pin-only-hash',
  pinSalt: 'pin-only-salt',
  pinLength: 4,
  isLocked: false,
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
  await user.click(screen.getByRole('button', { name: /start private setup/i }));
  await clickPin(user, '1234');
  await user.click(screen.getByRole('button', { name: /continue/i }));
  await clickPin(user, '1234');
  await user.click(screen.getByRole('button', { name: /confirm pin/i }));
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
    mocks.createInitialPin.mockReturnValue(pinOnlySecurity);
    mocks.createInitialPinWithRecovery.mockReturnValue(savedSecurity);
    mocks.startGoogleAuth.mockResolvedValue(googleSession);
    mocks.exchangeGoogleIdTokenForSupabaseSession.mockResolvedValue(supabaseSession);
    mocks.hasExistingPrimaryAccount.mockResolvedValue(false);
    mocks.createPrimaryAccount.mockResolvedValue({ accountId: 'account-1', deviceId: 'primary-1' });
    mocks.recoverPrimaryAccount.mockResolvedValue({ accountId: 'account-1', deviceId: 'recovered-primary-1' });
  });

  it('connects Google before asking new users to create an 8 digit passphrase', async () => {
    const user = userEvent.setup();
    renderLockScreen();
    expect(screen.getByLabelText(/setup progress: step 1 of 7/i)).toBeInTheDocument();
    await finishLocalSetup(user);

    expect(mocks.saveSecurityConfig).toHaveBeenCalledWith(pinOnlySecurity);

    expect(screen.queryByLabelText(/new 8-digit recovery passphrase/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /connect google account/i }));

    await screen.findByText(/Google connected/i);
    const createButton = screen.getByRole('button', { name: /create encrypted account/i });
    expect(createButton).toBeDisabled();

    await user.type(screen.getByLabelText(/security answer/i), 'Blue');

    await user.type(screen.getByLabelText(/new 8-digit recovery passphrase/i), '1234567');
    await user.type(screen.getByLabelText(/confirm 8-digit passphrase/i), '1234567');
    expect(createButton).toBeDisabled();

    await user.clear(screen.getByLabelText(/new 8-digit recovery passphrase/i));
    await user.clear(screen.getByLabelText(/confirm 8-digit passphrase/i));
    await user.type(screen.getByLabelText(/new 8-digit recovery passphrase/i), '12345678');
    await user.type(screen.getByLabelText(/confirm 8-digit passphrase/i), '12345678');
    expect(createButton).toBeEnabled();

    await user.click(createButton);

    await waitFor(() => expect(mocks.createPrimaryAccount).toHaveBeenCalledWith(expect.objectContaining({
      recoveryPassphrase: '12345678',
      googleSession,
      supabaseSession,
    })));
  }, 15_000);

  it('shows a security answer field when resuming setup from an incomplete saved state', async () => {
    const user = userEvent.setup();
    renderLockScreen();
    await finishLocalSetup(user);

    await user.click(screen.getByRole('button', { name: /connect google account/i }));

    expect(await screen.findByLabelText(/security answer/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create encrypted account/i })).toBeDisabled();
  }, 15_000);

  it('uses the saved ambient lock preference and lets returning users disable it', async () => {
    const user = userEvent.setup();
    const onSettingsChange = vi.fn();
    render(
      <LockScreen
        initialSettings={{ ...initialSettings, showAmbientLockScreen: true }}
        initialSecurity={savedSecurity}
        onSecurityChange={vi.fn()}
        onSettingsChange={onSettingsChange}
        onUnlock={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: /tap to unlock/i }));
    const ambientPreference = await screen.findByRole('checkbox', { name: /show clock before pin/i });
    expect(ambientPreference).toBeChecked();
    await user.click(ambientPreference);

    expect(onSettingsChange).toHaveBeenCalledWith(expect.objectContaining({ showAmbientLockScreen: false }));
  });

  it('unlocks a paired web companion with the transferred mobile PIN only', async () => {
    const user = userEvent.setup();
    const onUnlock = vi.fn();
    const pairedWebSecurity: SecurityConfig = {
      isPinCreated: true,
      pinHash: CryptoJS.SHA256('1234mobile-salt').toString(),
      pinSalt: 'mobile-salt',
      pinLength: 4,
      isBiometricsEnabled: false,
      isLocked: true,
    };
    mocks.getLocalSyncAccountState.mockResolvedValue({ deviceRole: 'web_companion' });

    render(
      <LockScreen
        initialSettings={initialSettings}
        initialSecurity={pairedWebSecurity}
        onSecurityChange={vi.fn()}
        onUnlock={onUnlock}
      />,
    );

    await clickPin(user, '1234');
    await user.click(screen.getByRole('button', { name: /unlock diary/i }));

    await waitFor(() => expect(onUnlock).toHaveBeenCalledOnce());
    expect(screen.queryByText(/add recovery question/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /connect google account/i })).not.toBeInTheDocument();
  });

  it('asks for the existing recovery passphrase when the Google account already exists', async () => {
    mocks.hasExistingPrimaryAccount.mockResolvedValue(true);
    const user = userEvent.setup();
    renderLockScreen();
    await finishLocalSetup(user);

    await user.click(screen.getByRole('button', { name: /connect google account/i }));

    await screen.findByText(/Encrypted account found/i);
    expect(screen.getByLabelText(/existing recovery passphrase/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/confirm 8-digit passphrase/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/migration|sync v1|sync v2/i)).not.toBeInTheDocument();
    const restoreButton = screen.getByRole('button', { name: /restore encrypted account/i });
    expect(restoreButton).toBeDisabled();
    await user.type(screen.getByLabelText(/existing recovery passphrase/i), 'old secret');
    expect(restoreButton).toBeEnabled();
    await user.click(restoreButton);
    await waitFor(() => expect(mocks.recoverPrimaryAccount).toHaveBeenCalledWith(expect.objectContaining({
      recoveryPassphrase: 'old secret',
      googleSession,
      supabaseSession,
    })));
    expect(mocks.createPrimaryAccount).not.toHaveBeenCalled();
  }, 15_000);
});
