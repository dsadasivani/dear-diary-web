import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Diary, SecurityConfig } from '../types';
import DiarySettingsScreen from './DiarySettingsScreen';

const repositoryMocks = vi.hoisted(() => ({
  deleteDiary: vi.fn(),
  listEntriesByDiary: vi.fn(),
}));

const verifyPinMock = vi.hoisted(() => vi.fn());

vi.mock('../repositories', () => ({
  diaryRepository: {
    deleteDiary: repositoryMocks.deleteDiary,
    listEntriesByDiary: repositoryMocks.listEntriesByDiary,
  },
}));

vi.mock('../domain/security', () => ({ verifyPin: verifyPinMock }));

const diary: Diary = {
  id: 'journal-1',
  name: 'Locked Journal',
  emoji: '📔',
  color: '#7C9885',
  isLocked: true,
  entryCount: 0,
  lastUpdated: 'Today',
  foilIcons: [],
};

const security: SecurityConfig = {
  isPinCreated: true,
  pinHash: 'hash',
  pinSalt: 'salt',
  pinLength: 4,
  isBiometricsEnabled: false,
  isLocked: false,
};

describe('DiarySettingsScreen', () => {
  beforeEach(() => {
    repositoryMocks.deleteDiary.mockReset().mockResolvedValue(true);
    repositoryMocks.listEntriesByDiary.mockReset().mockResolvedValue({ items: [], nextCursor: undefined });
    verifyPinMock.mockReset().mockReturnValue(true);
  });

  it('opens appearance from the mobile section navigation', async () => {
    render(<DiarySettingsScreen diary={diary} layout="mobile" security={security} onBack={vi.fn()} onRefreshDiaries={vi.fn()} />);

    const appearanceSectionLink = screen.getByRole('link', { name: 'Appearance' });
    expect(screen.getByRole('button', { expanded: false })).toBeInTheDocument();

    await userEvent.click(appearanceSectionLink);

    expect(appearanceSectionLink).toHaveAttribute('aria-current', 'location');
    expect(screen.getByRole('button', { expanded: true })).toBeInTheDocument();
  });

  it('requires the exact journal name and PIN before deleting a protected journal', async () => {
    const onBack = vi.fn();
    const onRefreshDiaries = vi.fn();
    render(<DiarySettingsScreen diary={diary} security={security} onBack={onBack} onRefreshDiaries={onRefreshDiaries} />);

    await userEvent.click(screen.getByRole('button', { name: 'Review deletion' }));
    const confirmButton = await screen.findByTestId('confirm-delete-journal-button');
    const nameField = screen.getByTestId('delete-journal-name-confirmation');
    expect(confirmButton).toBeDisabled();
    await userEvent.type(nameField, 'Locked journal');
    expect(confirmButton).toBeDisabled();
    fireEvent.change(screen.getByTestId('delete-journal-name-confirmation'), { target: { value: diary.name } });
    expect(screen.getByTestId('confirm-delete-journal-button')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('App PIN'), { target: { value: '1234' } });
    await waitFor(() => expect(screen.getByTestId('confirm-delete-journal-button')).toBeEnabled());

    await userEvent.click(screen.getByTestId('confirm-delete-journal-button'));

    await waitFor(() => expect(repositoryMocks.deleteDiary).toHaveBeenCalledWith(diary.id));
    expect(verifyPinMock).toHaveBeenCalledWith(security, '1234');
    expect(onRefreshDiaries).toHaveBeenCalledOnce();
    expect(onBack).toHaveBeenCalledOnce();
  });
});
