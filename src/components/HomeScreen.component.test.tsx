import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { HomeSummary } from '../repositories/DiaryRepository';
import type { UserProfile } from '../types';
import { AmbientThemeProvider } from '../design/ambientTheme';
import HomeScreen from './HomeScreen';

const repositoryMocks = vi.hoisted(() => ({
  getHomeSummary: vi.fn(),
  subscribeChanges: vi.fn(() => () => undefined),
}));

vi.mock('../repositories', () => ({
  diaryRepository: {
    getHomeSummary: repositoryMocks.getHomeSummary,
    subscribeChanges: repositoryMocks.subscribeChanges,
  },
}));

const profile: UserProfile = {
  name: 'Test Writer',
  email: 'writer@example.com',
  bio: '',
  avatarEmoji: '🌸',
  avatarColor: '#FFFFFF',
  writingGoal: 100,
  joinedDate: '07/2026',
};

const initialSummary: HomeSummary = {
  profile,
  recentDiaries: [
    {
      id: 'diary-1',
      name: 'My Diary',
      emoji: '📔',
      color: '#9F405B',
      isLocked: false,
      entryCount: 1,
      lastUpdated: 'Today',
      foilIcons: [],
    },
  ],
  recentEntries: [
    {
      id: 'entry-1',
      diaryId: 'diary-1',
      date: '2026-07-31',
      title: 'Already loaded entry',
      moodName: 'Joyful',
      moodEmoji: '😊',
      tags: [],
      photoCount: 0,
      wordCount: 12,
      createdAt: 1,
      updatedAt: 1,
    },
  ],
  recentPhotos: [],
  pinnedNotes: [],
  entryCount: 1,
  noteCount: 0,
  diaryCount: 1,
  todayWordCount: 12,
  currentStreak: 1,
  commonTags: [],
};

describe('HomeScreen', () => {
  it('renders the preserved summary and resumes the latest page directly in the editor', async () => {
    repositoryMocks.getHomeSummary.mockReturnValue(new Promise(() => undefined));
    const user = userEvent.setup();
    const onNavigate = vi.fn();

    render(
      <AmbientThemeProvider>
        <HomeScreen
          userProfile={profile}
          layout="mobile"
          initialSummary={initialSummary}
          onNavigate={onNavigate}
          onOpenQuickNote={vi.fn()}
          onOpenNewEntryWithPrompt={vi.fn()}
        />
      </AmbientThemeProvider>,
    );

    expect(screen.getAllByText('Already loaded entry')).not.toHaveLength(0);
    expect(screen.getByText('A moment worth keeping')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start writing' })).toBeInTheDocument();
    expect(screen.getByText('From your memories')).toBeInTheDocument();
    expect(screen.getByLabelText('Current writing streak')).toHaveTextContent('1 day streak');
    expect(screen.getByRole('progressbar', { name: 'Daily writing target' })).toHaveAttribute(
      'aria-valuenow',
      '12',
    );
    expect(screen.queryByText('Your recent pages will gather here.')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('home-continue-entry-button'));
    expect(onNavigate).toHaveBeenCalledWith('diaries', 'entryEditor', 'diary-1', 'entry-1');
  });
});
