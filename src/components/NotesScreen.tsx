import React, { useCallback, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Pin, Edit, Trash2, Plus, BookOpen,
  X, FileText, ClipboardList, Bold, Italic, Underline
} from 'lucide-react';
import { AppSettings, Note, ResponsiveLayout } from '../types';
import RichTextEditor from './RichTextEditor';
import { diaryRepository } from '../repositories';
import { getTagsForSettings } from '../domain/appSettings';
import OverlayPortal from './OverlayPortal';
import { SyncConflictError } from '../sync/eventSyncEngine';
import SanitizedRichText from './SanitizedRichText';
import { richTextHtmlToPlainText } from '../domain/richTextSanitizer';
import { useScreenPerformance } from '../hooks/useScreenPerformance';

interface NotesScreenProps {
  settings: AppSettings;
  layout?: ResponsiveLayout;
  onConvertToDiaryEntry: (noteTitle: string, noteBody: string, tags: string[]) => void | Promise<void>;
  initialNoteId?: string;
  onClearInitialNoteId?: () => void;
}

export default function NotesScreen({
  settings,
  layout = 'mobile',
  onConvertToDiaryEntry,
  initialNoteId,
  onClearInitialNoteId
}: NotesScreenProps) {
  useScreenPerformance('notes');
  const availableTags = getTagsForSettings(settings);

  const [activeFilter, setActiveFilter] = useState<'all' | 'pinned' | 'tagged' | 'untagged'>('all');
  const [notes, setNotes] = useState<Note[]>([]);
  const [noteTotal, setNoteTotal] = useState(0);
  const [noteQuery, setNoteQuery] = useState('');
  
  // Note creation inputs
  const [quickThought, setQuickThought] = useState<string>('');
  const [selectedTag, setSelectedTag] = useState<string>('ideas');
  
  // Note editing state
  const [editingNote, setEditingNote] = useState<Note | null>(null);
  const [editTitle, setEditingTitle] = useState<string>('');
  const [editBody, setEditingBody] = useState<string>('');
  const [editPinned, setEditingPinned] = useState<boolean>(false);
  const [editTags, setEditingTags] = useState<string[]>([]);
  const [showConfirmDeleteId, setShowConfirmDeleteId] = useState<string | null>(null);
  const [syncError, setSyncError] = useState('');

  const loadNotes = useCallback(async () => {
    const page = await diaryRepository.listNotes({
      filter: activeFilter,
      query: noteQuery,
      includeBody: true,
      limit: 200,
    });
    setNotes(page.items as Note[]);
    setNoteTotal(page.total ?? page.items.length);
  }, [activeFilter, noteQuery]);

  const pinnedNotes = notes.filter(n => n.isPinned);
  const totalNotes = noteTotal;

  React.useEffect(() => {
    void loadNotes();
    return diaryRepository.subscribeChanges((_revision, change) => {
      if (!change || change.type.startsWith('note-') || change.type === 'remote-batch-applied') {
        void loadNotes();
      }
    });
  }, [loadNotes]);

  React.useEffect(() => {
    if (initialNoteId) {
      void (async () => {
        const matched = notes.find(n => n.id === initialNoteId) || await diaryRepository.getNote(initialNoteId);
        if (matched) {
          setEditingNote(matched);
          setEditingTitle(matched.title === 'Untitled note' ? '' : matched.title);
          setEditingBody(matched.body);
          setEditingPinned(matched.isPinned);
          setEditingTags(matched.tags);
        }
      })();
      if (onClearInitialNoteId) {
        onClearInitialNoteId();
      }
    }
  }, [initialNoteId, notes, onClearInitialNoteId]);

  const handleSaveQuickNote = async () => {
    // A quick note might have html from quickThought if it were a rich text, but it's plain text here
    const plainTextBody = richTextHtmlToPlainText(quickThought);
    if (!plainTextBody) return;
    
    // Create new quick note
    await diaryRepository.createNote({
      title: plainTextBody.split('\n')[0].substring(0, 30) || 'Untitled note',
      body: quickThought,
      isPinned: false,
      tags: [selectedTag]
    });
    
    setQuickThought('');
    await loadNotes();
  };

  const handleStartEdit = (note: Note) => {
    setEditingNote(note);
    setEditingTitle(note.title === 'Untitled note' ? '' : note.title);
    setEditingBody(note.body);
    setEditingPinned(note.isPinned);
    setEditingTags(note.tags);
  };

  const handleSaveEdit = async () => {
    if (!editingNote) return;

    const finalTitle = editTitle.trim() || 'Untitled note';
    const updated: Note = {
      ...editingNote,
      title: finalTitle,
      body: editBody,
      isPinned: editPinned,
      tags: editTags
    };

    try {
      await diaryRepository.updateNote(updated);
      setEditingNote(null);
      setSyncError('');
      await loadNotes();
    } catch (saveError: any) {
      setSyncError(saveError?.message || 'Note could not be saved.');
      if (saveError instanceof SyncConflictError) {
        setEditingNote(null);
        await loadNotes();
      }
    }
  };

  const handleDeleteNote = async (id: string) => {
    await diaryRepository.deleteNote(id);
    setShowConfirmDeleteId(null);
    if (editingNote && editingNote.id === id) {
      setEditingNote(null);
    }
    await loadNotes();
  };

  const handleTogglePin = async (note: Note) => {
    await diaryRepository.updateNote({
      ...note,
      isPinned: !note.isPinned
    });
    await loadNotes();
  };

  const handleEditTagToggle = (tag: string) => {
    if (editTags.includes(tag)) {
      setEditingTags(prev => prev.filter(t => t !== tag));
    } else {
      setEditingTags(prev => [...prev, tag]);
    }
  };

  // Filter notes based on selection
  const filteredNotes = notes
    .filter(n => {
      if (activeFilter === 'pinned') return n.isPinned;
      if (activeFilter === 'tagged') return n.tags.length > 0;
      if (activeFilter === 'untagged') return n.tags.length === 0;
      return true; // 'all'
    })
    // Sort: pinned first, then by updatedTime descending
    .sort((a, b) => {
      if (a.isPinned && !b.isPinned) return -1;
      if (!a.isPinned && b.isPinned) return 1;
      return b.updatedAt - a.updatedAt;
    });

  const getTagEmoji = (tag: string) => {
    const matched = tag.toLowerCase();
    if (matched.includes('errands') || matched.includes('shopping') || matched.includes('grocery')) return '🛒';
    if (matched.includes('ideas') || matched.includes('dream')) return '💡';
    if (matched.includes('thought') || matched.includes('quotes') || matched.includes('reading')) return '💭';
    if (matched.includes('work') || matched.includes('study')) return '💼';
    return '📝';
  };

  const formatNoteDate = (timestamp: number) => {
    const d = new Date(timestamp);
    return d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const execCommand = (command: string) => {
    document.execCommand(command, false, undefined);
  };

  if (layout === 'desktop') {
    const activeNote = editingNote || filteredNotes[0] || null;

    return (
      <div className="grid grid-cols-1 overflow-hidden rounded-[28px] border border-brand-border bg-white/72 shadow-[0_18px_55px_rgba(62,36,41,0.08)] dark:bg-brand-card-bg/60 xl:grid-cols-[300px_minmax(0,1fr)] 2xl:grid-cols-[340px_minmax(0,1fr)]">
        <aside className="flex max-h-[420px] flex-col border-b border-brand-border bg-gradient-to-b from-brand-blush-light/68 to-white/35 dark:bg-brand-bg/30 xl:max-h-[calc(100vh-10rem)] xl:border-b-0 xl:border-r">
          <div className="border-b border-brand-border p-5">
            <div className="flex items-center justify-between">
              <div>
                <h1 className="font-serif-diary text-3xl font-bold text-brand-plum dark:text-brand-text">Your Notes</h1>
                <p className="mt-1 text-xs font-semibold text-brand-text-muted">{pinnedNotes.length} pinned, {totalNotes} total</p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setEditingNote(null);
                  setEditingTitle('');
                  setEditingBody('');
                  setEditingPinned(false);
                  setEditingTags([]);
                }}
                className="rounded-full border border-brand-border bg-white/55 p-2 text-brand-sage shadow-sm hover:bg-white"
                title="New quick note"
              >
                <Plus className="h-5 w-5" />
              </button>
            </div>
            <div className="relative mt-5">
              <FileText className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-brand-text-muted" />
              <input
                type="text"
                value={noteQuery}
                placeholder="Search notes..."
                className="w-full rounded-full border border-brand-border bg-white/72 py-2.5 pl-10 pr-4 text-sm font-semibold text-brand-plum outline-none transition-all focus:border-brand-sage focus:bg-white dark:bg-white/5 dark:text-brand-text"
                onChange={(event) => setNoteQuery(event.target.value)}
              />
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {(['all', 'pinned', 'tagged', 'untagged'] as const).map(filter => (
                <button
                  key={filter}
                  type="button"
                  onClick={() => setActiveFilter(filter)}
                  className={`rounded-full px-3 py-1.5 text-xs font-bold capitalize transition-all ${activeFilter === filter ? 'bg-brand-sage text-white shadow-sm' : 'bg-white/60 text-brand-sage hover:bg-white'}`}
                >
                  {filter}
                </button>
              ))}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <div className="space-y-3">
              {filteredNotes.map(note => {
                const isActive = activeNote?.id === note.id;
                return (
                  <button
                    key={note.id}
                    type="button"
                    onClick={() => handleStartEdit(note)}
                    className={`w-full rounded-[20px] border p-4 text-left transition-all ${
                      isActive
                        ? 'border-brand-sage bg-white shadow-[0_10px_26px_rgba(62,36,41,0.07)]'
                        : 'border-brand-border bg-white/58 hover:bg-white hover:shadow-sm dark:bg-white/5'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <span className="text-xs font-bold text-brand-text-muted">{formatNoteDate(note.updatedAt)}</span>
                      {note.isPinned && <Pin className="h-4 w-4 shrink-0 fill-brand-pink text-brand-pink" />}
                    </div>
                    <h2 className="mt-2 font-serif-diary text-lg font-bold text-brand-plum dark:text-brand-text">{note.title}</h2>
                    <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-brand-text-muted">{richTextHtmlToPlainText(note.body)}</p>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {note.tags.slice(0, 3).map(tag => (
                        <span key={tag} className="rounded-full bg-brand-sage-light px-2 py-0.5 text-[10px] font-bold text-brand-sage-dark">
                          {tag}
                        </span>
                      ))}
                    </div>
                  </button>
                );
              })}
              {filteredNotes.length === 0 && (
                <div className="rounded-[20px] border border-dashed border-brand-border bg-white/45 p-5 text-center">
                  <FileText className="mx-auto h-6 w-6 text-brand-sage/70" />
                  <p className="mt-3 text-sm font-bold text-brand-plum dark:text-brand-text">No notes here yet</p>
                  <p className="mt-1 text-xs leading-relaxed text-brand-text-muted">Try another filter or start a quick note.</p>
                </div>
              )}
            </div>
          </div>
        </aside>

        <main className="min-h-[620px] overflow-y-auto bg-white/82 dark:bg-brand-card-bg/75 xl:max-h-[calc(100vh-10rem)]">
          {syncError && (
            <p className="m-6 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 dark:border-red-900/40 dark:bg-red-950/20 dark:text-red-300">
              {syncError}
            </p>
          )}

          {editingNote ? (
            <section className="mx-auto max-w-4xl px-7 py-8 xl:px-10 xl:py-9 2xl:px-12">
              <div className="mb-8 flex items-center justify-between gap-4 border-b border-brand-border pb-5">
                <div className="flex items-center gap-2">
                  <button type="button" onMouseDown={(event) => { event.preventDefault(); execCommand('bold'); }} className="rounded-xl p-2 text-brand-sage hover:bg-brand-blush-light"><Bold className="h-4 w-4" /></button>
                  <button type="button" onMouseDown={(event) => { event.preventDefault(); execCommand('italic'); }} className="rounded-xl p-2 text-brand-sage hover:bg-brand-blush-light"><Italic className="h-4 w-4" /></button>
                  <button type="button" onMouseDown={(event) => { event.preventDefault(); execCommand('underline'); }} className="rounded-xl p-2 text-brand-sage hover:bg-brand-blush-light"><Underline className="h-4 w-4" /></button>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setEditingPinned(prev => !prev)}
                    className={`inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-bold ${editPinned ? 'border-brand-pink bg-brand-pink/10 text-brand-pink' : 'border-brand-border text-brand-sage'}`}
                  >
                    <Pin className="h-4 w-4" />
                    Pinned
                  </button>
                  <button
                    type="button"
                    onClick={() => onConvertToDiaryEntry(editTitle || editingNote.title, editBody, editTags)}
                    className="inline-flex items-center gap-2 rounded-full border border-brand-border px-4 py-2 text-sm font-bold text-brand-sage hover:bg-brand-blush-light"
                  >
                    <BookOpen className="h-4 w-4" />
                    Add to Diary
                  </button>
                </div>
              </div>

              <input
                type="text"
                value={editTitle}
                onChange={(event) => setEditingTitle(event.target.value)}
                placeholder="Note title..."
                className="w-full border-none bg-transparent text-center font-serif-diary text-4xl font-semibold tracking-tight text-brand-plum outline-none placeholder:text-brand-text-muted/30 dark:text-brand-text xl:text-[3rem]"
              />

              <div className="mt-6 flex flex-wrap justify-center gap-2">
                {availableTags.map(tag => {
                  const isSelected = editTags.includes(tag);
                  return (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => handleEditTagToggle(tag)}
                      className={`rounded-full px-3 py-1.5 text-xs font-bold transition-all ${isSelected ? 'bg-brand-sage text-white' : 'bg-brand-sage-light text-brand-sage-dark hover:bg-brand-blush-light'}`}
                    >
                      #{tag}
                    </button>
                  );
                })}
              </div>

              <div className="mt-10 rounded-[24px] border border-brand-border bg-brand-bg/32 p-7">
                <RichTextEditor
                  html={editBody}
                  onChange={setEditingBody}
                  placeholder="Write your note..."
                  className="min-h-[340px] w-full bg-transparent font-serif-diary text-2xl leading-[1.7] text-brand-plum outline-none dark:text-brand-text"
                />
              </div>

              <div className="mt-8 flex items-center justify-between border-t border-brand-border pt-5">
                <button
                  type="button"
                  onClick={() => setShowConfirmDeleteId(editingNote.id)}
                  className="rounded-full border border-red-200 px-4 py-2 text-sm font-bold text-red-700 hover:bg-red-50"
                >
                  Delete
                </button>
                <div className="flex gap-3">
                  <button type="button" onClick={() => setEditingNote(null)} className="rounded-full border border-brand-border px-5 py-3 text-sm font-bold text-brand-sage">
                    Discard
                  </button>
                  <button type="button" onClick={handleSaveEdit} className="rounded-full bg-brand-sage px-5 py-3 text-sm font-bold text-white">
                    Save Changes
                  </button>
                </div>
              </div>

              {showConfirmDeleteId === editingNote.id && (
                <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 p-4">
                  <p className="text-sm font-semibold text-red-700">Delete this note permanently?</p>
                  <div className="mt-3 flex gap-2">
                    <button type="button" onClick={() => handleDeleteNote(editingNote.id)} className="rounded-full bg-red-600 px-4 py-2 text-sm font-bold text-white">Confirm delete</button>
                    <button type="button" onClick={() => setShowConfirmDeleteId(null)} className="rounded-full border border-red-200 px-4 py-2 text-sm font-bold text-red-700">Cancel</button>
                  </div>
                </div>
              )}
            </section>
          ) : (
            <section className="mx-auto flex min-h-[620px] max-w-4xl flex-col justify-center px-8 py-10 xl:px-12">
              <p className="text-sm font-bold uppercase tracking-[0.2em] text-brand-sage">Quick capture</p>
              <h1 className="mt-3 font-serif-diary text-5xl font-semibold text-brand-plum dark:text-brand-text">Start a note</h1>
              <div className="mt-8 rounded-[24px] border border-brand-border bg-brand-bg/35 p-7 shadow-sm">
                <RichTextEditor
                  html={quickThought}
                  onChange={setQuickThought}
                  placeholder="Jot down a quick thought, shopping list, or temporary idea..."
                  className="min-h-[240px] w-full bg-transparent font-serif-diary text-2xl leading-relaxed text-brand-plum outline-none"
                />
                <div className="mt-5 flex items-center justify-between border-t border-brand-border pt-5">
                  <select
                    value={selectedTag}
                    onChange={(event) => setSelectedTag(event.target.value)}
                    className="rounded-full border border-brand-border bg-white px-4 py-2 text-sm font-bold text-brand-sage outline-none"
                  >
                    {availableTags.map(tag => <option key={tag} value={tag}>#{tag}</option>)}
                  </select>
                  <button type="button" onClick={handleSaveQuickNote} className="rounded-full bg-brand-sage px-5 py-3 text-sm font-bold text-white">
                    Save Note
                  </button>
                </div>
              </div>
            </section>
          )}
        </main>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 font-sans">
      {/* Header */}
      <header className="flex justify-between items-center bg-brand-bg/95 backdrop-blur-md sticky top-0 py-3 z-30">
        <div className="flex items-center gap-3">
          <span className="p-2 bg-brand-sage-light/20 text-brand-sage rounded-full">
            <ClipboardList className="w-5 h-5" />
          </span>
          <h1 className="font-serif-diary text-3xl text-brand-plum tracking-tight font-bold">Dear Diary</h1>
        </div>
        <div className="text-xs font-semibold text-brand-sage bg-brand-rose-light px-3 py-1.5 rounded-full">
          {pinnedNotes.length} Pinned • {totalNotes} Notes
        </div>
      </header>

      {syncError && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 dark:border-red-900/40 dark:bg-red-950/20 dark:text-red-300">
          {syncError}
        </p>
      )}

      {/* Quick Thought Textarea Input Card */}
      <section aria-label="Jot a quick note" className="w-full">
        <h2 className="font-serif-diary text-2xl font-bold text-brand-plum mb-3">Quick Notes</h2>
        <div className="bg-brand-sage-light/10 rounded-3xl p-4 border border-brand-sage-light/45 flex flex-col gap-3 relative focus-within:border-brand-sage transition-all duration-300 shadow-sm">
          <div className="flex items-center gap-2 pb-2 mb-2 border-b border-brand-rose-light/50">
            <button 
              type="button"
              onMouseDown={(e) => { e.preventDefault(); execCommand('bold'); }}
              className={`p-1.5 rounded-lg transition-all text-brand-sage hover:bg-brand-blush-light`}
            >
              <Bold className="w-4 h-4" />
            </button>
            <button 
              type="button"
              onMouseDown={(e) => { e.preventDefault(); execCommand('italic'); }}
              className={`p-1.5 rounded-lg transition-all text-brand-sage hover:bg-brand-blush-light`}
            >
              <Italic className="w-4 h-4" />
            </button>
            <button 
              type="button"
              onMouseDown={(e) => { e.preventDefault(); execCommand('underline'); }}
              className={`p-1.5 rounded-lg transition-all text-brand-sage hover:bg-brand-blush-light`}
            >
              <Underline className="w-4 h-4" />
            </button>
          </div>
          <RichTextEditor 
            html={quickThought}
            onChange={setQuickThought}
            placeholder="Jot down a quick thought, shopping list, or temporary idea..."
            className="w-full bg-transparent border-none text-sm text-brand-plum min-h-[80px]"
          />
          <div className="flex justify-between items-center border-t border-brand-rose-light/50 pt-3">
            <div className="flex items-center gap-2">
              <span className="text-xs text-brand-sage font-bold">Tag:</span>
              <select
                value={selectedTag}
                onChange={(e) => setSelectedTag(e.target.value)}
                className="text-xs font-bold text-brand-sage-dark bg-brand-card-bg border border-brand-border px-3 py-1 rounded-full focus:outline-none max-w-[120px] truncate"
              >
                {availableTags.map(t => (
                  <option key={t} value={t}>#{t}</option>
                ))}
              </select>
            </div>
            
            <button 
              onClick={handleSaveQuickNote}
              disabled={!richTextHtmlToPlainText(quickThought)}
              className="bg-brand-sage hover:bg-brand-sage-dark disabled:bg-brand-sage-light/35 disabled:cursor-not-allowed text-white font-bold text-xs px-4 py-2 rounded-full transition-all shadow-sm"
            >
              Save Note
            </button>
          </div>
        </div>
      </section>

      {/* Navigation Filter pills */}
      <div className="flex gap-2 py-1 max-w-full overflow-x-auto no-scrollbar border-b border-brand-rose-light/40">
        {(['all', 'pinned', 'tagged', 'untagged'] as const).map(filter => (
          <button
            key={filter}
            onClick={() => setActiveFilter(filter)}
            className={`px-4 py-1.5 rounded-full text-xs font-bold uppercase tracking-wider transition-all ${
              activeFilter === filter 
                ? 'bg-brand-pink text-white shadow-sm' 
                : 'text-brand-sage hover:bg-brand-blush-light'
            }`}
          >
            {filter}
          </button>
        ))}
      </div>

      {/* Notes List (Bento-style responsive asymmetrical grid layout) */}
      <section className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {filteredNotes.map((note, idx) => {
          const isErrand = note.tags.some(t => t === 'errands');
          // Double-width for third note in bento list
          const isDoubleWide = idx % 3 === 2;

          return (
            <article 
              key={note.id}
              className={`rounded-3xl p-5 border shadow-sm hover:shadow-md transition-all duration-300 flex flex-col justify-between group relative overflow-hidden ${
                isDoubleWide ? 'sm:col-span-2' : ''
              } ${
                isErrand 
                  ? 'bg-brand-sage-light/25 border-brand-sage-light' 
                  : 'bg-brand-card-bg border-brand-border'
              }`}
            >
              <div>
                <div className="flex justify-between items-start mb-3">
                  <span className="text-[10px] font-bold text-brand-sage uppercase tracking-wider">
                    {formatNoteDate(note.updatedAt)}
                  </span>
                  
                  <div className="flex flex-wrap justify-end items-center gap-1.5 max-w-[70%]">
                    {note.isPinned && <Pin className="w-3.5 h-3.5 text-brand-pink fill-brand-pink" />}
                    {note.tags.map(tag => (
                      <span 
                        key={tag} 
                        className={`text-[10px] font-bold uppercase tracking-widest px-2 py-1 rounded-full flex items-center gap-1 border truncate ${
                          isErrand 
                            ? 'bg-white/80 text-brand-sage-dark border-brand-sage-light' 
                            : 'bg-brand-blush-light text-brand-pink-dark border-brand-rose-light/50'
                        }`}
                      >
                        <span>{getTagEmoji(tag)}</span>
                        <span className="truncate max-w-[60px]">{tag}</span>
                      </span>
                    ))}
                  </div>
                </div>

                <h3 className={`font-serif-diary font-bold text-brand-plum mb-2 text-base ${isErrand ? 'line-through opacity-85' : ''}`}>
                  {note.title}
                </h3>
                <SanitizedRichText
                  className={`text-xs text-brand-plum leading-relaxed mb-4 [&_ul]:list-disc [&_ul]:ml-4 ${isErrand ? 'opacity-70 font-mono text-[11px]' : ''}`}
                  html={note.body}
                />
              </div>

              {/* Note actions toolbar, shown on card focus or hover */}
              <div className="flex justify-between items-center border-t border-brand-rose-light/40 pt-3 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity duration-300">
                <div className="flex items-center gap-1">
                  <button 
                    onClick={() => handleTogglePin(note)}
                    className="p-1.5 text-brand-sage hover:bg-brand-blush-light rounded-lg transition-colors"
                  >
                    <Pin className={`w-3.5 h-3.5 ${note.isPinned ? 'fill-brand-pink text-brand-pink' : ''}`} />
                  </button>
                  <button 
                    onClick={() => handleStartEdit(note)}
                    className="p-1.5 text-brand-sage hover:bg-brand-blush-light rounded-lg transition-colors"
                  >
                    <Edit className="w-3.5 h-3.5" />
                  </button>
                  
                  {showConfirmDeleteId !== note.id ? (
                    <button 
                      onClick={() => setShowConfirmDeleteId(note.id)}
                      className="p-1.5 text-brand-sage hover:text-red-600 rounded-lg transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  ) : (
                    <button 
                      onClick={() => handleDeleteNote(note.id)}
                      className="px-2 py-1 bg-red-100 text-red-700 hover:bg-red-200 rounded-lg text-[10px] font-bold transition-all"
                    >
                      Delete?
                    </button>
                  )}
                </div>

                <button 
                  onClick={() => onConvertToDiaryEntry(note.title, note.body, note.tags)}
                  className="flex items-center gap-1 text-brand-sage font-bold text-[10px] uppercase tracking-wider hover:text-brand-pink transition-colors p-1"
                >
                  <BookOpen className="w-3.5 h-3.5" />
                  Convert to Diary
                </button>
              </div>
            </article>
          );
        })}
      </section>

      {/* FULL NOTE EDIT DIALOG MODAL IF ACTIVE */}
      <AnimatePresence>
        {editingNote && (
          <OverlayPortal>
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-md">
            <motion.div 
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="w-full max-w-md bg-brand-card-bg rounded-3xl p-6 journal-shadow border border-brand-border flex flex-col gap-4 max-h-[85vh] overflow-y-auto"
            >
              <div className="flex justify-between items-center border-b border-brand-rose-light/50 pb-3">
                <h3 className="font-serif-diary text-lg font-bold text-brand-plum">Edit Quick Note</h3>
                <button onClick={() => setEditingNote(null)} className="text-brand-sage">
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="flex flex-col gap-4 py-2">
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-bold text-brand-sage uppercase tracking-wider">Note Title</label>
                  <input 
                    type="text" 
                    value={editTitle}
                    onChange={(e) => setEditingTitle(e.target.value)}
                    placeholder="Enter title..."
                    className="w-full bg-transparent border-b border-brand-rose-light py-1.5 text-base text-brand-plum font-serif-diary focus:outline-none focus:border-brand-pink"
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <div className="flex justify-between items-end">
                    <label className="text-xs font-bold text-brand-sage uppercase tracking-wider">Content</label>
                    <div className="flex items-center gap-1">
                      <button 
                        type="button"
                        onMouseDown={(e) => { e.preventDefault(); execCommand('bold'); }}
                        className={`p-1 rounded-md transition-all text-brand-sage hover:bg-brand-blush-light`}
                      >
                        <Bold className="w-3 h-3" />
                      </button>
                      <button 
                        type="button"
                        onMouseDown={(e) => { e.preventDefault(); execCommand('italic'); }}
                        className={`p-1 rounded-md transition-all text-brand-sage hover:bg-brand-blush-light`}
                      >
                        <Italic className="w-3 h-3" />
                      </button>
                      <button 
                        type="button"
                        onMouseDown={(e) => { e.preventDefault(); execCommand('underline'); }}
                        className={`p-1 rounded-md transition-all text-brand-sage hover:bg-brand-blush-light`}
                      >
                        <Underline className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                  <div className="border border-brand-rose-light/60 p-3 rounded-2xl focus-within:ring-1 focus-within:ring-brand-pink">
                    <RichTextEditor 
                      html={editBody}
                      onChange={setEditingBody}
                      placeholder="Note description..."
                      className="w-full bg-transparent text-sm text-brand-plum min-h-[100px]"
                    />
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-brand-sage uppercase tracking-wider">Pin to Top</span>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input 
                      type="checkbox" 
                      checked={editPinned}
                      onChange={(e) => setEditingPinned(e.target.checked)}
                      className="sr-only peer" 
                    />
                    <div className="w-11 h-6 bg-brand-sage-light/50 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-brand-sage-light after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-brand-sage" />
                  </label>
                </div>

                <div className="flex flex-col gap-1.5 mt-2">
                  <label className="text-xs font-bold text-brand-sage uppercase tracking-wider">Tag Categories</label>
                  <div className="flex flex-wrap gap-1.5">
                    {availableTags.map(tag => {
                      const isSelected = editTags.includes(tag);
                      return (
                        <button
                          key={tag}
                          type="button"
                          onClick={() => handleEditTagToggle(tag)}
                          className={`px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wide border transition-all ${
                            isSelected 
                              ? 'bg-brand-pink text-white border-brand-pink' 
                              : 'bg-brand-bg text-brand-sage-dark border-brand-rose-light/50 hover:bg-brand-rose-light/20'
                          }`}
                        >
                          #{tag}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              <div className="flex gap-3 pt-3 border-t border-brand-rose-light/50">
                <button
                  type="button"
                  onClick={() => setEditingNote(null)}
                  className="flex-1 py-2 rounded-full border border-brand-sage text-brand-sage font-bold text-xs"
                >
                  Discard
                </button>
                <button
                  type="button"
                  onClick={handleSaveEdit}
                  className="flex-1 py-2 rounded-full bg-brand-sage text-white font-bold text-xs"
                >
                  Save Changes
                </button>
              </div>
            </motion.div>
            </div>
          </OverlayPortal>
        )}
      </AnimatePresence>
    </div>
  );
}
