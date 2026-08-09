import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  it('adds checklist items and marks them complete', async () => {
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
    await user.click(screen.getByRole('button', { name: 'Add checklist item' }));

    const editor = screen.getByTestId('quick-note-editor');
    const item = editor.querySelector('li[data-checked="false"]');
    expect(item).not.toBeNull();
    (item as HTMLElement).textContent = 'Pack notebook';
    fireEvent.input(item as HTMLElement);
    const typedItem = editor.querySelector('li[data-checked="false"]');
    expect(typedItem).not.toBeNull();
    fireEvent.pointerDown(typedItem as HTMLElement, { clientX: 0 });

    await waitFor(() => expect(editor.querySelector('li')).toHaveAttribute('data-checked', 'true'));
    expect(editor).toHaveTextContent('Pack notebook');
  });
});
