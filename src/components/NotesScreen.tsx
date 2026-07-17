import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, BookOpen, MoreHorizontal, Pin, Plus, Search, Trash2 } from 'lucide-react';
import type { AppSettings, Diary, Note, ResponsiveLayout } from '../types';
import { getTagsForSettings } from '../domain/appSettings';
import { richTextHtmlToPlainText } from '../domain/richTextSanitizer';
import { diaryRepository } from '../repositories';
import RichTextEditor from './RichTextEditor';
import { AppButton, AppDialog, IconButton, StatusNotice } from './UiPrimitives';

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
}

type Filter = 'all' | 'pinned' | 'tagged' | 'untagged';

const emptyDraft = { title: '', body: '', isPinned: false, tags: [] as string[] };

export default function NotesScreen({ settings, diaries, layout = 'mobile', onConvertToDiaryEntry, initialNoteId, onClearInitialNoteId }: NotesScreenProps) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState(emptyDraft);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [deleteId, setDeleteId] = useState('');
  const [conversionNote, setConversionNote] = useState<Note | null>(null);
  const [conversionJournalId, setConversionJournalId] = useState(diaries[0]?.id || '');
  const [conversionTitle, setConversionTitle] = useState('');
  const [conversionDate, setConversionDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [conversionDisposition, setConversionDisposition] = useState<'keep' | 'delete'>('keep');
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
      if (!change || change.type.startsWith('note-') || change.type === 'remote-batch-applied') void loadNotes();
    });
  }, [loadNotes]);

  useEffect(() => {
    if (!initialNoteId || notes.length === 0) return;
    const note = notes.find(item => item.id === initialNoteId);
    if (note) openEditor(note);
    onClearInitialNoteId?.();
  }, [initialNoteId, notes, onClearInitialNoteId]);

  useEffect(() => {
    if (!conversionJournalId && diaries[0]) setConversionJournalId(diaries[0].id);
  }, [conversionJournalId, diaries]);

  const visible = useMemo(() => notes
    .filter(note => {
      if (filter === 'pinned') return note.isPinned;
      if (filter === 'tagged') return note.tags.length > 0;
      if (filter === 'untagged') return note.tags.length === 0;
      return true;
    })
    .filter(note => {
      const needle = query.trim().toLowerCase();
      return !needle || note.title.toLowerCase().includes(needle) || richTextHtmlToPlainText(note.body).toLowerCase().includes(needle) || note.tags.some(tag => tag.includes(needle));
    })
    .sort((left, right) => Number(right.isPinned) - Number(left.isPinned) || right.updatedAt - left.updatedAt), [filter, notes, query]);

  function openEditor(note: Note) {
    setEditingId(note.id);
    setCreating(false);
    setDraft({ title: note.title, body: note.body, isPinned: note.isPinned, tags: [...note.tags] });
  }

  const openCreator = () => {
    setEditingId(null);
    setCreating(true);
    setDraft(emptyDraft);
  };

  const closeEditor = () => {
    setCreating(false);
    setEditingId(null);
    setDraft(emptyDraft);
  };

  const saveDraft = async () => {
    const title = draft.title.trim() || richTextHtmlToPlainText(draft.body).trim().slice(0, 48) || 'Untitled note';
    if (editingId) {
      const original = notes.find(note => note.id === editingId);
      if (original) await diaryRepository.updateNote({ ...original, ...draft, title });
    } else {
      await diaryRepository.createNote({ ...draft, title });
    }
    await loadNotes();
    closeEditor();
  };

  const togglePin = async (note: Note) => {
    await diaryRepository.updateNote({ ...note, isPinned: !note.isPinned });
    await loadNotes();
  };

  const removeNote = async (id: string) => {
    await diaryRepository.deleteNote(id);
    setDeleteId('');
    if (editingId === id) closeEditor();
    await loadNotes();
  };

  const openConversion = (note: Note) => {
    setConversionNote(note);
    setConversionTitle(note.title);
    setConversionDate(new Date().toISOString().slice(0, 10));
    setConversionJournalId(diaries[0]?.id || '');
    setConversionDisposition('keep');
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

  const Editor = ({ fullScreen = false }: { fullScreen?: boolean }) => (
    <section className={`${fullScreen ? 'fixed inset-0 z-[70] overflow-y-auto bg-brand-bg p-4 mobile-overlay-safe' : 'min-h-[620px] bg-brand-card-bg p-6'} flex flex-col gap-5`} aria-label={editingId ? 'Edit note' : 'New note'}>
      <header className="flex items-center justify-between border-b border-brand-border pb-3">
        <div className="flex items-center gap-3"><IconButton label="Close note editor" onClick={closeEditor}><ArrowLeft className="h-5 w-5" /></IconButton><div><p className="app-eyebrow">Notes</p><h2 className="font-serif-diary text-2xl font-semibold">{editingId ? 'Edit note' : 'New note'}</h2></div></div>
        <AppButton tone="primary" onClick={() => void saveDraft()}>{editingId ? 'Save Changes' : 'Save Note'}</AppButton>
      </header>
      <label className="text-sm font-bold">Title
        <input data-testid="note-title-input" value={draft.title} onChange={event => setDraft(current => ({ ...current, title: event.target.value }))} placeholder="Optional title" className="mt-2 min-h-11 w-full rounded-xl border border-brand-border bg-brand-card-bg px-4 text-base outline-none focus:border-brand-sage" />
      </label>
      <label className="flex min-h-12 items-center justify-between rounded-xl border border-brand-border px-3 text-sm font-bold">Pin to top<input type="checkbox" checked={draft.isPinned} onChange={event => setDraft(current => ({ ...current, isPinned: event.target.checked }))} className="h-5 w-5 accent-brand-sage" /></label>
      <div className="flex min-h-[220px] flex-1 flex-col rounded-2xl border border-brand-border bg-brand-card-bg p-4 focus-within:border-brand-sage">
        <RichTextEditor html={draft.body} onChange={body => setDraft(current => ({ ...current, body }))} placeholder="Write a quick thought…" testId={editingId ? 'note-edit-editor' : 'quick-note-editor'} className="min-h-[200px] flex-1 text-base leading-relaxed" />
      </div>
      <fieldset><legend className="text-sm font-bold">Tags</legend><div className="mt-2 flex flex-wrap gap-2">{availableTags.map(tag => { const selected = draft.tags.includes(tag); return <button key={tag} type="button" aria-pressed={selected} onClick={() => setDraft(current => ({ ...current, tags: selected ? current.tags.filter(item => item !== tag) : [...current.tags, tag] }))} className={`min-h-9 rounded-full border px-3 text-xs font-bold ${selected ? 'border-brand-sage bg-brand-sage-light text-brand-sage-dark' : 'border-brand-border'}`}>#{tag}</button>; })}</div></fieldset>
      {editingId && <div className="mt-auto flex flex-wrap gap-2 border-t border-brand-border pt-4"><AppButton onClick={() => { const note = notes.find(item => item.id === editingId); if (note) openConversion({ ...note, ...draft }); }}><BookOpen className="h-4 w-4" />Convert to Entry</AppButton><AppButton tone="danger" data-testid="note-delete-button" onClick={() => setDeleteId(editingId)}><Trash2 className="h-4 w-4" />Delete</AppButton>{deleteId === editingId && <AppButton tone="danger" data-testid="note-confirm-delete-button" onClick={() => void removeNote(editingId)}>Confirm delete</AppButton>}</div>}
    </section>
  );

  const ListPanel = () => (
    <section className="min-w-0">
      <div className="surface-card mb-4 grid gap-2 p-3 sm:grid-cols-[minmax(0,1fr)_auto]">
        <label className="relative"><span className="sr-only">Search notes</span><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-brand-text-muted" /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search notes" className="min-h-11 w-full rounded-xl border border-brand-border bg-brand-bg/40 pl-10 pr-3 text-base outline-none focus:border-brand-sage" /></label>
        <label className="sr-only" htmlFor="note-filter">Filter notes</label><select id="note-filter" value={filter} onChange={event => setFilter(event.target.value as Filter)} className="min-h-11 rounded-xl border border-brand-border bg-brand-card-bg px-3 text-sm font-bold"><option value="all">All notes</option><option value="pinned">Pinned</option><option value="tagged">Tagged</option><option value="untagged">Untagged</option></select>
      </div>
      <div className="surface-card divide-y divide-brand-border overflow-hidden">
        {visible.map(note => (
          <article key={note.id} data-testid="note-card" className="p-4">
            <div className="flex items-start gap-3">
              <button type="button" data-testid="note-edit-button" onClick={() => openEditor(note)} className="min-w-0 flex-1 text-left">
                <span className="flex items-center gap-2"><span className="truncate font-serif-diary text-lg font-bold text-brand-plum dark:text-brand-text">{note.title}</span>{note.isPinned && <Pin className="h-3.5 w-3.5 shrink-0 text-brand-pink" aria-label="Pinned" />}</span>
                <span className="mt-1 block line-clamp-2 text-sm leading-relaxed text-brand-text-muted">{richTextHtmlToPlainText(note.body) || 'Empty note'}</span>
                <span className="mt-2 flex flex-wrap items-center gap-2 text-xs text-brand-text-muted"><span>{new Date(note.updatedAt).toLocaleString()}</span>{note.tags.map(tag => <span key={tag}>#{tag}</span>)}</span>
              </button>
              <div className="flex shrink-0 items-center gap-1">
                <IconButton label={note.isPinned ? 'Unpin note' : 'Pin note'} onClick={() => void togglePin(note)}><Pin className="h-4 w-4" /></IconButton>
                <IconButton label="Convert note to entry" onClick={() => openConversion(note)}><BookOpen className="h-4 w-4" /></IconButton>
                <IconButton label="Delete note" data-testid="note-delete-button" onClick={() => setDeleteId(note.id)}><Trash2 className="h-4 w-4" /></IconButton>
              </div>
            </div>
            {deleteId === note.id && <div className="mt-3 flex items-center justify-end gap-2"><AppButton tone="quiet" onClick={() => setDeleteId('')}>Cancel</AppButton><AppButton tone="danger" data-testid="note-confirm-delete-button" onClick={() => void removeNote(note.id)}>Delete note</AppButton></div>}
          </article>
        ))}
        {!loading && visible.length === 0 && <div className="p-12 text-center"><MoreHorizontal className="mx-auto h-8 w-8 text-brand-sage" /><p className="mt-3 font-serif-diary text-xl font-semibold">No notes found</p><p className="mt-1 text-sm text-brand-text-muted">Capture a thought or adjust the filter.</p></div>}
      </div>
    </section>
  );

  return (
    <div className="space-y-6 pb-20">
      <header className="flex items-end justify-between gap-4"><div><h1 className="font-serif-diary text-3xl font-semibold md:text-4xl">Notes</h1><p className="mt-1 text-sm text-brand-text-muted">Lightweight thoughts, kept close.</p></div><AppButton tone="primary" data-testid="new-note-button" onClick={openCreator}><Plus className="h-4 w-4" />New Note</AppButton></header>
      {error && <StatusNotice role="alert" tone="danger">{error}</StatusNotice>}
      {layout === 'desktop' ? <div className="grid overflow-hidden rounded-2xl border border-brand-border xl:grid-cols-[340px_minmax(0,1fr)]"><div className="border-r border-brand-border p-4"><ListPanel /></div>{creating || editingId ? <Editor /> : <div className="flex min-h-[620px] items-center justify-center p-8 text-center"><div><BookOpen className="mx-auto h-10 w-10 text-brand-sage" /><h2 className="mt-3 font-serif-diary text-2xl font-semibold">Select a note</h2><p className="mt-1 text-sm text-brand-text-muted">Open a note to edit it here.</p></div></div>}</div> : <><ListPanel />{(creating || editingId) && <Editor fullScreen />}</>}

      <AppDialog open={Boolean(conversionNote)} title="Convert to journal entry" description="Review where this note will go and what happens to the original." onClose={() => setConversionNote(null)} footer={<><AppButton onClick={() => setConversionNote(null)}>Cancel</AppButton><AppButton tone="primary" onClick={() => void convert()} disabled={!conversionJournalId}>Create Entry</AppButton></>}>
        <div className="space-y-4">
          {diaries.length === 0 ? <StatusNotice tone="warning">Create a journal before converting this note.</StatusNotice> : <label className="block text-sm font-bold">Journal<select value={conversionJournalId} onChange={event => setConversionJournalId(event.target.value)} className="mt-2 min-h-11 w-full rounded-xl border border-brand-border bg-brand-card-bg px-3">{diaries.map(diary => <option key={diary.id} value={diary.id}>{diary.name}</option>)}</select></label>}
          <label className="block text-sm font-bold">Entry title<input value={conversionTitle} onChange={event => setConversionTitle(event.target.value)} className="mt-2 min-h-11 w-full rounded-xl border border-brand-border bg-brand-card-bg px-3" /></label>
          <label className="block text-sm font-bold">Entry date<input type="date" value={conversionDate} onChange={event => setConversionDate(event.target.value)} className="mt-2 min-h-11 w-full rounded-xl border border-brand-border bg-brand-card-bg px-3" /></label>
          <fieldset><legend className="text-sm font-bold">Original note</legend><label className="mt-2 flex min-h-12 items-center gap-3 rounded-xl border border-brand-border p-3 text-sm"><input type="radio" checked={conversionDisposition === 'keep'} onChange={() => setConversionDisposition('keep')} />Keep original note</label><label className="mt-2 flex min-h-12 items-center gap-3 rounded-xl border border-brand-border p-3 text-sm"><input type="radio" checked={conversionDisposition === 'delete'} onChange={() => setConversionDisposition('delete')} />Delete original after conversion</label></fieldset>
        </div>
      </AppDialog>
    </div>
  );
}
