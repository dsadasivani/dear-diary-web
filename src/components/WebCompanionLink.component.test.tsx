import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import WebCompanionLink, {
  ANDROID_APP_URL,
  canCompleteWebCompanionPairing,
} from './WebCompanionLink';

vi.mock('../sync/webGoogleAuth', () => ({
  restoreWebGoogleSyncSession: vi.fn(async () => null),
  startWebGoogleSyncSignIn: vi.fn(),
}));

vi.mock('../sync/v2/v2CompanionPairing', () => ({
  completeSyncV2CompanionPairing: vi.fn(),
  getPendingSyncV2CompanionPairing: vi.fn(),
  requestSyncV2CompanionPairing: vi.fn(),
}));

vi.mock('../repositories', () => ({
  diaryRepository: {
    getLocalSyncAccountState: vi.fn(async () => null),
  },
}));

describe('WebCompanionLink', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('explains the Android-first model before offering companion sign-in', async () => {
    render(<WebCompanionLink onLinked={vi.fn()} />);

    expect(screen.getByRole('heading', { name: 'Loredays.' })).toBeInTheDocument();
    expect(screen.getByText('Your story starts on your phone.')).toBeInTheDocument();
    expect(screen.getByText('Install on Android')).toBeInTheDocument();
    expect(screen.getByText('Set up Loredays')).toBeInTheDocument();
    expect(screen.getByText('Link this browser')).toBeInTheDocument();

    const download = screen.getByRole('link', { name: /get it on google play/i });
    expect(download).toHaveAttribute('href', ANDROID_APP_URL);
    expect(screen.getByRole('button', { name: /continue with google/i })).toBeInTheDocument();
  });

  it('waits for the encrypted package before completing an approved pairing', () => {
    expect(canCompleteWebCompanionPairing('REQUESTED')).toBe(false);
    expect(canCompleteWebCompanionPairing('APPROVED')).toBe(false);
    expect(canCompleteWebCompanionPairing('KEY_PACKAGE_PENDING')).toBe(false);
    expect(canCompleteWebCompanionPairing('KEY_PACKAGE_AVAILABLE')).toBe(true);
    expect(canCompleteWebCompanionPairing('COMPLETED')).toBe(true);
  });
});
