import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_APP_SETTINGS } from '../repositories/defaults';
import NotesScreen from './NotesScreen';

const changeSubscribers: Array<(revision: number, change?: { type: string }) => void> = [];

const repositoryMocks = vi.hoisted(() => ({
  listNotes: vi.fn(),
  getNote: vi.fn(),
  subscribeChanges: vi.fn(),
}));

vi.mock('../repositories', () => ({
  diaryRepository: {
    listNotes: repositoryMocks.listNotes,
    getNote: repositoryMocks.getNote,
    subscribeChanges: repositoryMocks.subscribeChanges,
  },
}));

describe('NotesScreen', () => {
  beforeEach(() => {
    repositoryMocks.listNotes
      .mockReset()
      .mockResolvedValue({ items: [], total: 0, nextCursor: undefined });
    repositoryMocks.getNote.mockReset().mockResolvedValue(null);
    changeSubscribers.length = 0;
    repositoryMocks.subscribeChanges.mockReset().mockImplementation((callback) => {
      changeSubscribers.push(callback);
      return vi.fn();
    });
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

  it('loads notes in bounded pages and appends the next page', async () => {
    const firstPage = Array.from({ length: 40 }, (_, index) => ({
      id: `note-${index}`,
      title: `Note ${index}`,
      body: `<p>Body ${index}</p>`,
      isPinned: false,
      tags: [],
      createdAt: index,
      updatedAt: index,
    }));
    const secondPage = [
      {
        id: 'note-40',
        title: 'Note 40',
        body: '<p>Body 40</p>',
        isPinned: false,
        tags: [],
        createdAt: 40,
        updatedAt: 40,
      },
    ];
    repositoryMocks.listNotes
      .mockResolvedValueOnce({ items: firstPage, total: 41, nextCursor: 'page-2' })
      .mockResolvedValueOnce({ items: secondPage, total: 41, nextCursor: undefined });
    const user = userEvent.setup();

    render(
      <NotesScreen
        settings={DEFAULT_APP_SETTINGS}
        diaries={[]}
        layout="mobile"
        onConvertToDiaryEntry={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getAllByTestId('note-card')).toHaveLength(40));
    expect(repositoryMocks.listNotes).toHaveBeenNthCalledWith(1, {
      filter: 'all',
      query: undefined,
      includeBody: true,
      limit: 40,
      cursor: undefined,
    });
    await user.click(screen.getByRole('button', { name: 'Load more (40 of 41)' }));
    await waitFor(() => expect(screen.getAllByTestId('note-card')).toHaveLength(41));
    expect(repositoryMocks.listNotes).toHaveBeenNthCalledWith(2, {
      filter: 'all',
      query: undefined,
      includeBody: true,
      limit: 40,
      cursor: 'page-2',
    });
  });

  it('debounces search and sends it to paged storage', async () => {
    const user = userEvent.setup();
    render(
      <NotesScreen
        settings={DEFAULT_APP_SETTINGS}
        diaries={[]}
        layout="mobile"
        onConvertToDiaryEntry={vi.fn()}
      />,
    );
    await waitFor(() => expect(repositoryMocks.listNotes).toHaveBeenCalledTimes(1));

    await user.type(screen.getByRole('textbox', { name: 'Search notes' }), 'five years');

    await waitFor(
      () =>
        expect(repositoryMocks.listNotes).toHaveBeenLastCalledWith(
          expect.objectContaining({ query: 'five years', limit: 40 }),
        ),
      { timeout: 1_000 },
    );
  });

  it('ignores a queued refresh from an obsolete search subscription', async () => {
    const match = {
      id: 'matching-note',
      title: 'Needle note',
      body: '<p>Matching body</p>',
      isPinned: false,
      tags: [],
      createdAt: 1,
      updatedAt: 1,
    };
    repositoryMocks.listNotes
      .mockResolvedValueOnce({ items: [], total: 0, nextCursor: undefined })
      .mockResolvedValueOnce({ items: [match], total: 1, nextCursor: undefined })
      .mockResolvedValueOnce({ items: [], total: 0, nextCursor: undefined });
    const user = userEvent.setup();
    render(
      <NotesScreen
        settings={DEFAULT_APP_SETTINGS}
        diaries={[]}
        layout="mobile"
        onConvertToDiaryEntry={vi.fn()}
      />,
    );
    await waitFor(() => expect(repositoryMocks.listNotes).toHaveBeenCalledTimes(1));
    const obsoleteSubscriber = changeSubscribers[0];

    await user.type(screen.getByRole('textbox', { name: 'Search notes' }), 'needle');
    await screen.findByText('Needle note');
    await act(async () => {
      obsoleteSubscriber(2, { type: 'note-updated' });
    });
    expect(repositoryMocks.listNotes).toHaveBeenCalledTimes(2);

    expect(screen.getByText('Needle note')).toBeVisible();
    expect(screen.getByText(/1 note ·/)).toBeVisible();
  });
});
