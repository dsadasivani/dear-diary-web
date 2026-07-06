import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Pin, Edit, Trash2, Tag, Calendar, Plus, BookOpen, 
  X, Check, HelpCircle, FileText, Share2, ClipboardList, Bold, Italic, Underline
} from 'lucide-react';
import { AppSettings, Note } from '../types';
import RichTextEditor from './RichTextEditor';
import { diaryRepository } from '../repositories';
import { getTagsForSettings } from '../domain/appSettings';
import OverlayPortal from './OverlayPortal';
import { SyncConflictError } from '../sync/eventSyncEngine';

interface NotesScreenProps {
  notes: Note[];
  settings: AppSettings;
  onRefreshNotes: () => void | Promise<void>;
  onConvertToDiaryEntry: (noteTitle: string, noteBody: string, tags: string[]) => void | Promise<void>;
  initialNoteId?: string;
  onClearInitialNoteId?: () => void;
}

export default function NotesScreen({
  notes,
  settings,
  onRefreshNotes,
  onConvertToDiaryEntry,
  initialNoteId,
  onClearInitialNoteId
}: NotesScreenProps) {
  const availableTags = getTagsForSettings(settings);

  const [activeFilter, setActiveFilter] = useState<'all' | 'pinned' | 'tagged' | 'untagged'>('all');
  
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

  const pinnedNotes = notes.filter(n => n.isPinned);
  const totalNotes = notes.length;

  React.useEffect(() => {
    if (initialNoteId) {
      const matched = notes.find(n => n.id === initialNoteId);
      if (matched) {
        setEditingNote(matched);
        setEditingTitle(matched.title === 'Untitled note' ? '' : matched.title);
        setEditingBody(matched.body);
        setEditingPinned(matched.isPinned);
        setEditingTags(matched.tags);
      }
      if (onClearInitialNoteId) {
        onClearInitialNoteId();
      }
    }
  }, [initialNoteId, notes]);

  const handleSaveQuickNote = async () => {
    // A quick note might have html from quickThought if it were a rich text, but it's plain text here
    const plainTextBody = quickThought.replace(/<[^>]*>?/gm, '').trim();
    if (!plainTextBody) return;
    
    // Create new quick note
    await diaryRepository.createNote({
      title: plainTextBody.split('\n')[0].substring(0, 30) || 'Untitled note',
      body: quickThought,
      isPinned: false,
      tags: [selectedTag]
    });
    
    setQuickThought('');
    await onRefreshNotes();
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
      await onRefreshNotes();
    } catch (saveError: any) {
      setSyncError(saveError?.message || 'Note could not be saved.');
      if (saveError instanceof SyncConflictError) {
        setEditingNote(null);
        await onRefreshNotes();
      }
    }
  };

  const handleDeleteNote = async (id: string) => {
    await diaryRepository.deleteNote(id);
    setShowConfirmDeleteId(null);
    if (editingNote && editingNote.id === id) {
      setEditingNote(null);
    }
    await onRefreshNotes();
  };

  const handleTogglePin = async (note: Note) => {
    await diaryRepository.updateNote({
      ...note,
      isPinned: !note.isPinned
    });
    await onRefreshNotes();
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
              disabled={!quickThought.replace(/<[^>]*>?/gm, '').trim()}
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
                <div 
                  className={`text-xs text-brand-plum leading-relaxed mb-4 [&_ul]:list-disc [&_ul]:ml-4 ${isErrand ? 'opacity-70 font-mono text-[11px]' : ''}`}
                  dangerouslySetInnerHTML={{ __html: note.body }}
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
