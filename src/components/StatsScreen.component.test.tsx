import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import StatsScreen from './StatsScreen';

const repositoryMocks = vi.hoisted(() => ({
  searchEntries: vi.fn(),
  listNotes: vi.fn(),
  getGlobalStatistics: vi.fn(),
  getEntry: vi.fn(),
  subscribeChanges: vi.fn(() => () => undefined),
}));

vi.mock('../repositories', () => ({
  diaryRepository: repositoryMocks,
}));

const dateKey = (year: number, month: number, day: number) =>
  `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

describe('StatsScreen desktop insights', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth();
    const comparisonMonth = currentMonth === 0 ? 1 : currentMonth - 1;
    const entries = [
      {
        id: 'entry-1',
        diaryId: 'diary-1',
        date: dateKey(currentYear, currentMonth, 1),
        title: 'A calm morning',
        moodName: 'Calm',
        moodEmoji: 'Calm',
        tags: ['morning'],
        photoUris: [],
      },
      {
        id: 'entry-2',
        diaryId: 'diary-1',
        date: dateKey(currentYear, currentMonth, 2),
        title: 'A quiet afternoon',
        moodName: 'Calm',
        moodEmoji: 'Calm',
        tags: ['quiet'],
        photoUris: [],
      },
      {
        id: 'entry-3',
        diaryId: 'diary-1',
        date: dateKey(currentYear, currentMonth, 3),
        title: 'A bright evening',
        moodName: 'Joyful',
        moodEmoji: 'Joyful',
        tags: ['evening'],
        photoUris: [],
      },
      {
        id: 'entry-4',
        diaryId: 'diary-1',
        date: dateKey(currentYear, comparisonMonth, 4),
        title: 'A joyful memory',
        moodName: 'Joyful',
        moodEmoji: 'Joyful',
        tags: ['memory'],
        photoUris: [],
      },
    ];
    repositoryMocks.searchEntries.mockResolvedValue({ items: entries, nextCursor: undefined });
    repositoryMocks.listNotes.mockResolvedValue({ items: [], nextCursor: undefined });
    repositoryMocks.getGlobalStatistics.mockResolvedValue({ photoCount: 0 });
  });

  it('uses the selected month for its narrative and supports changing the month', async () => {
    const user = userEvent.setup();
    const now = new Date();
    const currentMonth = now.getMonth();
    const comparisonMonth = currentMonth === 0 ? 1 : currentMonth - 1;

    render(<StatsScreen diaries={[]} layout="desktop" onNavigate={vi.fn()} />);

    const currentNarrative = await screen.findByText(/You wrote 3 reflections in/);
    expect(currentNarrative).toHaveTextContent('Calm was the mood you chose most often.');
    expect(screen.getByLabelText('Insight highlights')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Your writing, gently reflected' })).toBeVisible();

    await user.selectOptions(screen.getByLabelText('Month'), String(comparisonMonth));

    const comparisonNarrative = await screen.findByText(/You wrote 1 reflection in/);
    expect(comparisonNarrative).toHaveTextContent('Joyful was the mood you chose most often.');
  });
});
