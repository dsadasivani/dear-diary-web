import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_APP_SETTINGS } from '../repositories/defaults';
import NotesScreen from './NotesScreen';

const repositoryMocks = vi.hoisted(() => ({
  listNotes: vi.fn(),
  subscribeChanges: vi.fn(),
}));

vi.mock('../repositories', () => ({
  diaryRepository: {
    listNotes: repositoryMocks.listNotes,
    subscribeChanges: repositoryMocks.subscribeChanges,
  },
}));

describe('NotesScreen', () => {
  beforeEach(() => {
    repositoryMocks.listNotes.mockReset().mockResolvedValue([]);
    repositoryMocks.subscribeChanges.mockReset().mockReturnValue(vi.fn());
  });

  it('keeps focus and typed text in the title field while creating a note', async () => {
    const user = userEvent.setup();
    render(
      <NotesScreen
        settings={DEFAULT_APP_SETTINGS}
        diaries={[]}
        layout="mobile"
        onConvertToDiaryEntry={vi.fn()}
      />,
    );

    await waitFor(() => expect(repositoryMocks.listNotes).toHaveBeenCalled());
    await user.click(screen.getAllByRole('button', { name: 'New Note' })[0]);

    const title = screen.getByTestId('note-title-input');
    await user.click(title);
    await user.type(title, 'Forward title');

    expect(title).toHaveFocus();
    expect(title).toHaveValue('Forward title');

    const body = screen.getByTestId('quick-note-editor');
    await user.click(body);
    await user.type(body, 'Forward body');

    expect(body).toHaveFocus();
    expect(body).toHaveTextContent('Forward body');
  });
});
