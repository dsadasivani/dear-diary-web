import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  BookOpen,
  GripVertical,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import type { AppSettings, Diary, Note, ResponsiveLayout } from '../types';
import { getTagsForSettings } from '../domain/appSettings';
import { richTextHtmlToPlainText } from '../domain/richTextSanitizer';
import { diaryRepository } from '../repositories';
import { toLocalDateKey } from '../utils/localDate';
import RichTextEditor from './RichTextEditor';
import { AppButton, AppDialog, IconButton, StatusNotice } from './UiPrimitives';
import { BottomSheet, ConfirmationSheet } from './ui/BottomSheet';
import { AutosaveIndicator, EmptyState, LoadingSkeleton } from './ui/Feedback';

export interface NoteConversionRequest {
  noteId: string;
  journalId: string;
  title: string;
  body: string;
  tags: string[];
  date: string;
  disposition: 'keep' | 'delete';
}

interface NotesScreenProps {
  settings: AppSettings;
  diaries: Diary[];
  layout?: ResponsiveLayout;
  onConvertToDiaryEntry: (request: NoteConversionRequest) => void | Promise<void>;
  initialNoteId?: string;
  onClearInitialNoteId?: () => void;
  onFocusedFlowChange?: (active: boolean, onBack?: () => void) => void;
}

type Filter = 'all' | 'pinned' | 'tagged' | 'untagged';
const emptyDraft = { title: '', body: '', isPinned: false, tags: [] as string[] };
const NOTES_PANE_WIDTH_KEY = 'deardiary_notes_pane_width';
const NOTES_PANE_COLLAPSED_KEY = 'deardiary_notes_pane_collapsed';
const MIN_NOTES_PANE_WIDTH = 280;
const MAX_NOTES_PANE_WIDTH = 520;

const clampNotesPaneWidth = (width: number) =>
  Math.min(MAX_NOTES_PANE_WIDTH, Math.max(MIN_NOTES_PANE_WIDTH, width));

export default function NotesScreen({
  settings,
  diaries,
  layout = 'mobile',
  onConvertToDiaryEntry,
  initialNoteId,
  onClearInitialNoteId,
  onFocusedFlowChange,
}: NotesScreenProps) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState(emptyDraft);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [deleteId, setDeleteId] = useState('');
  const [menuNoteId, setMenuNoteId] = useState('');
  const [revealedNoteId, setRevealedNoteId] = useState('');
  const touchStartX = useRef<number | null>(null);
  const [conversionNote, setConversionNote] = useState<Note | null>(null);
  const [conversionJournalId, setConversionJournalId] = useState(diaries[0]?.id || '');
  const [conversionTitle, setConversionTitle] = useState('');
  const [conversionDate, setConversionDate] = useState(() => toLocalDateKey());
  const [conversionDisposition, setConversionDisposition] = useState<'keep' | 'delete'>('keep');
  const [listPaneWidth, setListPaneWidth] = useState(() => {
    if (typeof window === 'undefined') return 340;
    const stored = Number.parseInt(window.localStorage.getItem(NOTES_PANE_WIDTH_KEY) || '', 10);
    return Number.isFinite(stored) ? clampNotesPaneWidth(stored) : 340;
  });
  const [listPaneCollapsed, setListPaneCollapsed] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.localStorage.getItem(NOTES_PANE_COLLAPSED_KEY) === 'true',
  );
  const resizeStart = useRef<{ x: number; width: number } | null>(null);
  const availableTags = getTagsForSettings(settings);

  const loadNotes = useCallback(async () => {
    try {
      setNotes(await diaryRepository.listNotes());
      setError('');
    } catch (loadError: any) {
      setError(loadError?.message || 'Notes could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadNotes();
    return diaryRepository.subscribeChanges((_revision, change) => {
      if (!change || change.type.startsWith('note-') || change.type === 'remote-batch-applied')
        void loadNotes();
    });
  }, [loadNotes]);

  useEffect(() => {
    if (initialNoteId === '__new_note__') {
      openCreator();
      onClearInitialNoteId?.();
      return;
    }
    if (!initialNoteId || notes.length === 0) return;
    const note = notes.find((item) => item.id === initialNoteId);
    if (note) openEditor(note);
    onClearInitialNoteId?.();
  }, [initialNoteId, notes, onClearInitialNoteId]);

  useEffect(() => {
    if (!conversionJournalId && diaries[0]) setConversionJournalId(diaries[0].id);
  }, [conversionJournalId, diaries]);

  const visible = useMemo(
    () =>
      notes
        .filter(
          (note) =>
            filter === 'all' ||
            (filter === 'pinned'
              ? note.isPinned
              : filter === 'tagged'
                ? note.tags.length > 0
                : note.tags.length === 0),
        )
        .filter((note) => {
          const needle = query.trim().toLowerCase();
          return (
            !needle ||
            note.title.toLowerCase().includes(needle) ||
            richTextHtmlToPlainText(note.body).toLowerCase().includes(needle) ||
            note.tags.some((tag) => tag.includes(needle))
          );
        })
        .sort(
          (left, right) =>
            Number(right.isPinned) - Number(left.isPinned) || right.updatedAt - left.updatedAt,
        ),
    [filter, notes, query],
  );

  function openEditor(note: Note) {
    setEditingId(note.id);
    setCreating(false);
    setDraft({ title: note.title, body: note.body, isPinned: note.isPinned, tags: [...note.tags] });
    setMenuNoteId('');
  }

  const openCreator = () => {
    setEditingId(null);
    setCreating(true);
    setDraft(emptyDraft);
  };
  const closeEditor = useCallback(() => {
    setCreating(false);
    setEditingId(null);
    setDraft(emptyDraft);
    setDeleteId('');
  }, []);
  const focusedFlowActive = creating || editingId !== null;

  useEffect(() => {
    if (!focusedFlowActive) {
      onFocusedFlowChange?.(false);
      return;
    }
    onFocusedFlowChange?.(true, closeEditor);
    return () => onFocusedFlowChange?.(false);
  }, [closeEditor, focusedFlowActive, onFocusedFlowChange]);

  const persistPaneWidth = (width: number) => {
    if (typeof window !== 'undefined')
      window.localStorage.setItem(NOTES_PANE_WIDTH_KEY, String(width));
  };

  const updatePaneWidth = (width: number, persist = false) => {
    const nextWidth = clampNotesPaneWidth(width);
    setListPaneWidth(nextWidth);
    if (persist) persistPaneWidth(nextWidth);
  };

  const toggleListPane = () => {
    setListPaneCollapsed((current) => {
      const next = !current;
      if (typeof window !== 'undefined')
        window.localStorage.setItem(NOTES_PANE_COLLAPSED_KEY, String(next));
      return next;
    });
  };

  const saveDraft = async () => {
    const hasContent = Boolean(draft.title.trim() || richTextHtmlToPlainText(draft.body).trim());
    if (saving || !hasContent) return;
    setSaving(true);
    try {
      const title =
        draft.title.trim() ||
        richTextHtmlToPlainText(draft.body).trim().slice(0, 48) ||
        'Untitled note';
      if (editingId) {
        const original = notes.find((note) => note.id === editingId);
        if (original) await diaryRepository.updateNote({ ...original, ...draft, title });
      } else {
        await diaryRepository.createNote({ ...draft, title });
      }
      await loadNotes();
      closeEditor();
    } finally {
      setSaving(false);
    }
  };

  const togglePin = async (note: Note) => {
    await diaryRepository.updateNote({ ...note, isPinned: !note.isPinned });
    await loadNotes();
    setMenuNoteId('');
  };
  const removeNote = async (id: string) => {
    await diaryRepository.deleteNote(id);
    setDeleteId('');
    setMenuNoteId('');
    if (editingId === id) closeEditor();
    await loadNotes();
  };

  const openConversion = (note: Note) => {
    setConversionNote(note);
    setConversionTitle(note.title);
    setConversionDate(toLocalDateKey());
    setConversionJournalId(diaries[0]?.id || '');
    setConversionDisposition('keep');
    setMenuNoteId('');
  };

  const convert = async () => {
    if (!conversionNote || !conversionJournalId) return;
    await onConvertToDiaryEntry({
      noteId: conversionNote.id,
      journalId: conversionJournalId,
      title: conversionTitle.trim() || conversionNote.title,
      body: conversionNote.body,
      tags: conversionNote.tags,
      date: conversionDate,
      disposition: conversionDisposition,
    });
    setConversionNote(null);
    closeEditor();
    await loadNotes();
  };

  const activeMenuNote = notes.find((note) => note.id === menuNoteId) || null;
  const canSaveDraft = Boolean(draft.title.trim() || richTextHtmlToPlainText(draft.body).trim());

  // Keep the editor subtree mounted across draft updates so focus and the rich-text caret survive.
  const renderEditor = (fullScreen = false) => (
    <section
      className={`${fullScreen ? 'fixed inset-0 z-[70] overflow-y-auto bg-brand-bg px-4 pb-8 pt-3 mobile-overlay-safe' : 'surface-paper min-h-[650px] px-7 py-5 xl:px-10'} flex flex-col`}
      aria-label={editingId ? 'Edit note' : 'New note'}
    >
      <header className="surface-glass-strong sticky top-0 z-20 -mx-2 flex items-center justify-between gap-3 border-b border-brand-border/60 px-2 py-2">
        <IconButton label="Close note editor" onClick={closeEditor}>
          <ArrowLeft className="h-5 w-5" />
        </IconButton>
        <AutosaveIndicator
          status={saving ? 'saving' : 'idle'}
          message={saving ? 'Saving note…' : 'Stored locally'}
        />
        <div className="flex items-center gap-1">
          <IconButton
            label={draft.isPinned ? 'Unpin note' : 'Pin note'}
            aria-pressed={draft.isPinned}
            onClick={() => setDraft((current) => ({ ...current, isPinned: !current.isPinned }))}
          >
            <Pin className={`h-4 w-4 ${draft.isPinned ? 'fill-current text-brand-pink' : ''}`} />
          </IconButton>
          <AppButton
            tone="primary"
            onClick={() => void saveDraft()}
            disabled={saving || !canSaveDraft}
          >
            {editingId ? 'Save Changes' : 'Save Note'}
          </AppButton>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col py-8">
        <input
          data-testid="note-title-input"
          aria-label="Note title"
          value={draft.title}
          onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
          placeholder="Optional title"
          className="w-full border-0 border-b border-brand-border/40 bg-transparent pb-3 font-serif-diary text-3xl font-semibold text-brand-plum outline-none placeholder:text-brand-text-muted/35 focus:border-brand-pink dark:text-brand-text"
        />
        <RichTextEditor
          html={draft.body}
          onChange={(body) => setDraft((current) => ({ ...current, body }))}
          placeholder="Write a quick thought…"
          testId={editingId ? 'note-edit-editor' : 'quick-note-editor'}
          autoFocus={!editingId}
          className="mt-7 min-h-[300px] flex-1 font-serif-diary text-lg leading-[1.75] text-brand-plum dark:text-brand-text"
        />

        <details className="mt-8 border-y border-brand-border/60 py-3">
          <summary className="cursor-pointer text-sm font-bold text-brand-sage">
            Details and tags
          </summary>
          <fieldset className="mt-4">
            <legend className="sr-only">Tags</legend>
            <div className="flex flex-wrap gap-2">
              {availableTags.map((tag) => {
                const selected = draft.tags.includes(tag);
                return (
                  <button
                    key={tag}
                    type="button"
                    aria-pressed={selected}
                    onClick={() =>
                      setDraft((current) => ({
                        ...current,
                        tags: selected
                          ? current.tags.filter((item) => item !== tag)
                          : [...current.tags, tag],
                      }))
                    }
                    className={`min-h-9 rounded-full border px-3 text-xs font-bold ${selected ? 'border-brand-sage bg-brand-sage-light text-brand-sage-dark' : 'border-brand-border text-brand-text-muted'}`}
                  >
                    #{tag}
                  </button>
                );
              })}
            </div>
          </fieldset>
        </details>

        {editingId && (
          <div className="mt-auto mb-[var(--bottom-navigation-clearance)] flex flex-wrap gap-2 border-t border-brand-border/60 pt-6 md:mb-0">
            <AppButton
              onClick={() => {
                const note = notes.find((item) => item.id === editingId);
                if (note) openConversion({ ...note, ...draft });
              }}
            >
              <BookOpen className="h-4 w-4" />
              Convert to Entry
            </AppButton>
            <AppButton
              tone="danger"
              data-testid="note-delete-button"
              onClick={() => setDeleteId(editingId)}
            >
              <Trash2 className="h-4 w-4" />
              Delete
            </AppButton>
            {deleteId === editingId && (
              <AppButton
                tone="danger"
                data-testid="note-confirm-delete-button"
                onClick={() => void removeNote(editingId)}
              >
                Confirm delete
              </AppButton>
            )}
          </div>
        )}
      </main>
    </section>
  );

  const ListPanel = () => (
    <section className="min-w-0" aria-label="Notes list">
      <div className="mb-4 grid gap-2 border-y border-brand-border/60 py-3 sm:grid-cols-[minmax(0,1fr)_auto]">
        <label className="relative">
          <span className="sr-only">Search notes</span>
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-brand-text-muted" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a note"
            className="min-h-11 w-full rounded-full border border-brand-border bg-transparent pl-10 pr-3 text-base outline-none focus:border-brand-sage"
          />
        </label>
        <label className="sr-only" htmlFor="note-filter">
          Filter notes
        </label>
        <select
          id="note-filter"
          value={filter}
          onChange={(event) => setFilter(event.target.value as Filter)}
          className="min-h-11 rounded-full border border-brand-border bg-brand-card-bg px-3 text-sm font-bold"
        >
          <option value="all">All notes</option>
          <option value="pinned">Pinned</option>
          <option value="tagged">Tagged</option>
          <option value="untagged">Untagged</option>
        </select>
      </div>

      {loading ? (
        <LoadingSkeleton lines={5} className="py-8" label="Loading notes" />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={<BookOpen className="h-5 w-5" />}
          title="No notes found"
          description="Try another search or create a note."
          action={
            <AppButton tone="primary" onClick={openCreator}>
              New Note
            </AppButton>
          }
        />
      ) : (
        <div className="divide-y divide-brand-border/60 border-y border-brand-border/60 overflow-hidden">
          {visible.map((note) => (
            <article key={note.id} data-testid="note-card" className="relative overflow-hidden">
              <div className="absolute inset-y-0 right-0 flex w-24 items-center justify-center bg-brand-rose/10">
                <button
                  type="button"
                  onClick={() => setDeleteId(note.id)}
                  className="flex min-h-11 flex-col items-center justify-center gap-1 px-3 text-xs font-bold text-brand-rose"
                >
                  <Trash2 className="h-4 w-4" />
                  Delete
                </button>
              </div>
              <div
                className="relative flex items-start gap-3 bg-brand-bg px-1 py-4 transition-transform duration-200 dark:bg-brand-bg"
                style={{ transform: revealedNoteId === note.id ? 'translateX(-6rem)' : undefined }}
                onTouchStart={(event) => {
                  touchStartX.current = event.touches[0]?.clientX ?? null;
                }}
                onTouchEnd={(event) => {
                  const start = touchStartX.current;
                  const end = event.changedTouches[0]?.clientX;
                  touchStartX.current = null;
                  if (start == null || end == null) return;
                  if (start - end > 45) setRevealedNoteId(note.id);
                  if (end - start > 45) setRevealedNoteId('');
                }}
              >
                <button
                  type="button"
                  data-testid="note-edit-button"
                  onClick={() => openEditor(note)}
                  className="min-w-0 flex-1 text-left"
                >
                  <span className="flex items-center gap-2">
                    <span className="truncate font-serif-diary text-xl font-semibold text-brand-plum dark:text-brand-text">
                      {note.title}
                    </span>
                    {note.isPinned && (
                      <Pin
                        className="h-3.5 w-3.5 shrink-0 fill-current text-brand-pink"
                        aria-label="Pinned"
                      />
                    )}
                  </span>
                  <span
                    className={`mt-1 block text-sm leading-relaxed text-brand-text-muted ${layout === 'mobile' ? 'line-clamp-1' : 'line-clamp-2'}`}
                  >
                    {richTextHtmlToPlainText(note.body) || 'Empty note'}
                  </span>
                  <span
                    className={`mt-2 text-xs text-brand-text-muted ${layout === 'mobile' && !note.tags.length ? 'hidden' : 'block'}`}
                  >
                    {layout !== 'mobile' && new Date(note.updatedAt).toLocaleDateString()}
                    {note.tags.length
                      ? `${layout === 'mobile' ? '' : ' · '}${note.tags
                          .slice(0, 2)
                          .map((tag) => `#${tag}`)
                          .join(' ')}`
                      : ''}
                  </span>
                </button>
                <IconButton
                  label={`More actions for ${note.title}`}
                  onClick={() => setMenuNoteId(note.id)}
                >
                  <MoreHorizontal className="h-5 w-5" />
                </IconButton>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );

  return (
    <div className="space-y-6 pb-20">
      <header className="flex items-end justify-between gap-4">
        {layout !== 'mobile' && (
          <div>
            <h1 className="type-page-title font-bold">Notes</h1>
            <p className="mt-1 text-sm text-brand-text-muted">Lightweight thoughts, kept close.</p>
          </div>
        )}
        <AppButton tone="primary" data-testid="new-note-button" onClick={openCreator}>
          <Plus className="h-4 w-4" />
          New Note
        </AppButton>
      </header>
      {error && (
        <StatusNotice role="alert" tone="danger">
          {error}
        </StatusNotice>
      )}
      {layout === 'desktop' ? (
        <div className="flex min-h-[650px] overflow-hidden border-y border-brand-border/60">
          <aside
            className="relative shrink-0 overflow-hidden"
            style={{ width: listPaneCollapsed ? 56 : listPaneWidth }}
            aria-label="Notes navigation pane"
          >
            <div
              className={`flex items-center py-2 ${listPaneCollapsed ? 'justify-center' : 'justify-end pr-3'}`}
            >
              <IconButton
                label={listPaneCollapsed ? 'Expand notes list' : 'Collapse notes list'}
                aria-expanded={!listPaneCollapsed}
                aria-controls="desktop-notes-list"
                onClick={toggleListPane}
              >
                {listPaneCollapsed ? (
                  <PanelLeftOpen className="h-4 w-4" />
                ) : (
                  <PanelLeftClose className="h-4 w-4" />
                )}
              </IconButton>
            </div>
            {!listPaneCollapsed && (
              <div
                id="desktop-notes-list"
                className="h-[calc(100%-3.25rem)] overflow-y-auto px-1 pr-5"
              >
                <ListPanel />
              </div>
            )}
          </aside>

          {!listPaneCollapsed && (
            <div
              role="separator"
              aria-label="Resize notes list"
              aria-orientation="vertical"
              aria-valuemin={MIN_NOTES_PANE_WIDTH}
              aria-valuemax={MAX_NOTES_PANE_WIDTH}
              aria-valuenow={listPaneWidth}
              tabIndex={0}
              className="group flex w-3 shrink-0 cursor-col-resize touch-none items-center justify-center border-x border-brand-border/60 outline-none transition-colors hover:bg-brand-sage-light/40 focus-visible:bg-brand-sage-light/60"
              onPointerDown={(event) => {
                resizeStart.current = { x: event.clientX, width: listPaneWidth };
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                if (!resizeStart.current || !event.currentTarget.hasPointerCapture(event.pointerId))
                  return;
                updatePaneWidth(resizeStart.current.width + event.clientX - resizeStart.current.x);
              }}
              onPointerUp={(event) => {
                if (!resizeStart.current) return;
                const finalWidth = clampNotesPaneWidth(
                  resizeStart.current.width + event.clientX - resizeStart.current.x,
                );
                resizeStart.current = null;
                event.currentTarget.releasePointerCapture(event.pointerId);
                setListPaneWidth(finalWidth);
                persistPaneWidth(finalWidth);
              }}
              onPointerCancel={() => {
                resizeStart.current = null;
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowLeft') {
                  event.preventDefault();
                  updatePaneWidth(listPaneWidth - 16, true);
                }
                if (event.key === 'ArrowRight') {
                  event.preventDefault();
                  updatePaneWidth(listPaneWidth + 16, true);
                }
                if (event.key === 'Home') {
                  event.preventDefault();
                  updatePaneWidth(MIN_NOTES_PANE_WIDTH, true);
                }
                if (event.key === 'End') {
                  event.preventDefault();
                  updatePaneWidth(MAX_NOTES_PANE_WIDTH, true);
                }
              }}
            >
              <GripVertical
                className="h-5 w-5 text-brand-text-muted transition-colors group-hover:text-brand-sage"
                aria-hidden="true"
              />
            </div>
          )}

          <div className="min-w-0 flex-1">
            {creating || editingId ? (
              renderEditor()
            ) : (
              <EmptyState
                icon={<BookOpen className="h-6 w-6" />}
                title="Select a note"
                description="Open a lightweight thought to continue writing."
              />
            )}
          </div>
        </div>
      ) : (
        <>
          <ListPanel />
          {(creating || editingId) && renderEditor(true)}
        </>
      )}

      <BottomSheet
        open={Boolean(activeMenuNote)}
        title={activeMenuNote?.title || 'Note actions'}
        onClose={() => setMenuNoteId('')}
      >
        {activeMenuNote && (
          <div className="divide-y divide-brand-border/60 border-y border-brand-border/60">
            <button
              type="button"
              onClick={() => void togglePin(activeMenuNote)}
              className="flex min-h-12 w-full items-center gap-3 text-left text-sm font-bold"
            >
              <Pin className="h-4 w-4" />
              {activeMenuNote.isPinned ? 'Unpin note' : 'Pin note'}
            </button>
            <button
              type="button"
              onClick={() => openConversion(activeMenuNote)}
              className="flex min-h-12 w-full items-center gap-3 text-left text-sm font-bold"
            >
              <BookOpen className="h-4 w-4" />
              Convert to journal entry
            </button>
            <button
              type="button"
              onClick={() => {
                setMenuNoteId('');
                setDeleteId(activeMenuNote.id);
              }}
              className="flex min-h-12 w-full items-center gap-3 text-left text-sm font-bold text-brand-rose"
            >
              <Trash2 className="h-4 w-4" />
              Delete note
            </button>
          </div>
        )}
      </BottomSheet>

      <ConfirmationSheet
        open={Boolean(deleteId) && deleteId !== editingId}
        title="Delete this note?"
        message="This note will be permanently removed from this device and encrypted sync."
        confirmLabel="Delete note"
        destructive
        onClose={() => setDeleteId('')}
        onConfirm={() => void removeNote(deleteId)}
      />

      <AppDialog
        open={Boolean(conversionNote)}
        title="Convert to journal entry"
        description="Review where this note will go and what happens to the original."
        onClose={() => setConversionNote(null)}
        footer={
          <>
            <AppButton onClick={() => setConversionNote(null)}>Cancel</AppButton>
            <AppButton
              tone="primary"
              onClick={() => void convert()}
              disabled={!conversionJournalId}
            >
              Create Entry
            </AppButton>
          </>
        }
      >
        <div className="space-y-4">
          {diaries.length === 0 ? (
            <StatusNotice tone="warning">
              Create a journal before converting this note.
            </StatusNotice>
          ) : (
            <label className="block text-sm font-bold">
              Journal
              <select
                value={conversionJournalId}
                onChange={(event) => setConversionJournalId(event.target.value)}
                className="mt-2 min-h-11 w-full rounded-xl border border-brand-border bg-brand-card-bg px-3"
              >
                {diaries.map((diary) => (
                  <option key={diary.id} value={diary.id}>
                    {diary.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="block text-sm font-bold">
            Entry title
            <input
              value={conversionTitle}
              onChange={(event) => setConversionTitle(event.target.value)}
              className="mt-2 min-h-11 w-full rounded-xl border border-brand-border bg-brand-card-bg px-3"
            />
          </label>
          <label className="block text-sm font-bold">
            Entry date
            <input
              type="date"
              value={conversionDate}
              onChange={(event) => setConversionDate(event.target.value)}
              className="mt-2 min-h-11 w-full rounded-xl border border-brand-border bg-brand-card-bg px-3"
            />
          </label>
          <fieldset>
            <legend className="text-sm font-bold">Original note</legend>
            <label className="mt-2 flex min-h-12 items-center gap-3 border-y border-brand-border p-3 text-sm">
              <input
                type="radio"
                checked={conversionDisposition === 'keep'}
                onChange={() => setConversionDisposition('keep')}
              />
              Keep original note
            </label>
            <label className="flex min-h-12 items-center gap-3 border-b border-brand-border p-3 text-sm">
              <input
                type="radio"
                checked={conversionDisposition === 'delete'}
                onChange={() => setConversionDisposition('delete')}
              />
              Delete original after conversion
            </label>
          </fieldset>
        </div>
      </AppDialog>
    </div>
  );
}
