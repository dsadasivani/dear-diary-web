import React, { useRef, useState } from 'react';
import { ArrowLeft, Check, ImagePlus, LayoutGrid, List, Lock, Plus, Search, Trash2 } from 'lucide-react';
import type { Diary, ResponsiveLayout } from '../types';
import { PREDEFINED_COLORS } from '../domain/journalCatalog';
import { persistNativeLocalStorageItem } from '../mobile/nativeStorageBridge';
import { persistOptimizedImageFile } from '../mobile/mediaStorage';
import { diaryRepository } from '../repositories';
import JournalCover from './JournalCover';
import { AppButton, IconButton } from './UiPrimitives';

type DiaryViewMode = 'compact' | 'list';

interface DiariesScreenProps {
  diaries: Diary[];
  layout?: ResponsiveLayout;
  onNavigate: (tab: string, screen?: string, diaryId?: string, entryId?: string) => void;
  onRefreshDiaries: () => void | Promise<void>;
}

const EMOJI_OPTIONS = ['📔', '✈️', '🌙', '🌿', '🎨', '💼', '☕', '🏠', '🔑', '📝', '🌸', '✨'];
const FOIL_ICON_OPTIONS = ['⭐', '👑', '🕊️', '🍀', '🗝️', '💎', '🌙', '☀️', '🌸', '✨', '🔥', '🪐'];

export default function DiariesScreen({ diaries, layout = 'mobile', onNavigate, onRefreshDiaries }: DiariesScreenProps) {
  const [creating, setCreating] = useState(false);
  const [customizing, setCustomizing] = useState(false);
  const [query, setQuery] = useState('');
  const [viewMode, setViewMode] = useState<DiaryViewMode>(() => localStorage.getItem('deardiary_diary_viewmode') === 'compact' ? 'compact' : 'list');
  const [sortBy, setSortBy] = useState<'updated' | 'name' | 'entries' | 'created'>('updated');
  const [filterBy, setFilterBy] = useState<'all' | 'locked' | 'unlocked' | 'empty'>('all');
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('📔');
  const [color, setColor] = useState(PREDEFINED_COLORS[0].hex);
  const [locked, setLocked] = useState(false);
  const [coverImage, setCoverImage] = useState<string>();
  const [foilIcons, setFoilIcons] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const coverInputRef = useRef<HTMLInputElement>(null);

  const visible = diaries
    .filter(diary => !query.trim() || diary.name.toLowerCase().includes(query.trim().toLowerCase()))
    .filter(diary => filterBy === 'all' || (filterBy === 'locked' && diary.isLocked) || (filterBy === 'unlocked' && !diary.isLocked) || (filterBy === 'empty' && diary.entryCount === 0))
    .sort((left, right) => {
      if (sortBy === 'name') return left.name.localeCompare(right.name);
      if (sortBy === 'entries') return right.entryCount - left.entryCount;
      if (sortBy === 'created') return diaries.indexOf(right) - diaries.indexOf(left);
      return (right.lastEntryUpdatedAt || 0) - (left.lastEntryUpdatedAt || 0);
    });
  const latest = [...diaries].sort((left, right) => (right.lastEntryUpdatedAt || 0) - (left.lastEntryUpdatedAt || 0))[0];
  const totalEntries = diaries.reduce((sum, diary) => sum + diary.entryCount, 0);

  const setMode = (mode: DiaryViewMode) => {
    setViewMode(mode);
    localStorage.setItem('deardiary_diary_viewmode', mode);
    persistNativeLocalStorageItem('deardiary_diary_viewmode', mode);
  };

  const resetDraft = () => {
    setName(''); setEmoji('📔'); setColor(PREDEFINED_COLORS[0].hex); setLocked(false);
    setCoverImage(undefined); setFoilIcons([]); setCustomizing(false);
  };

  const createJournal = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      await diaryRepository.createDiary({ name: name.trim(), emoji, color, isLocked: locked, coverImage, foilIcons });
      await onRefreshDiaries();
      resetDraft();
      setCreating(false);
    } finally {
      setSaving(false);
    }
  };

  const uploadCover = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    void persistOptimizedImageFile(file, 'cover').then(setCoverImage).catch(error => console.warn('Cover image could not be attached:', error));
  };

  if (creating) {
    const preview: Diary = { id: 'preview', name: name || 'Untitled journal', emoji, color, isLocked: locked, entryCount: 0, lastUpdated: 'Now', coverImage, foilIcons };
    return (
      <form onSubmit={createJournal} className="mx-auto max-w-4xl space-y-6 pb-24">
        <header className="sticky top-0 z-30 flex items-center justify-between border-b border-brand-border bg-brand-bg/92 py-3 backdrop-blur-lg">
          <IconButton label="Back to journals" onClick={() => { resetDraft(); setCreating(false); }}><ArrowLeft className="h-5 w-5" /></IconButton>
          <div className="text-center"><p className="app-eyebrow">Create</p><h1 className="font-serif-diary text-2xl font-semibold">New Journal</h1></div>
          <AppButton type="submit" tone="primary" disabled={!name.trim() || saving}>{saving ? 'Creating…' : 'Create Journal'}</AppButton>
        </header>

        <div className={`grid gap-6 ${layout === 'mobile' ? '' : 'grid-cols-[240px_minmax(0,1fr)] items-start'}`}>
          <div className={`${layout === 'mobile' ? '' : 'sticky top-24'} flex justify-center`}><JournalCover diary={preview} variant="preview" className="w-44" /></div>
          <main className="space-y-5">
            <section className="surface-card space-y-4 p-5">
              <label className="block text-sm font-bold text-brand-plum dark:text-brand-text">Journal name
                <input value={name} onChange={event => setName(event.target.value)} placeholder="e.g., Evening Reflections" autoFocus className="mt-2 min-h-11 w-full rounded-xl border border-brand-border bg-brand-bg/45 px-4 text-base outline-none focus:border-brand-sage" />
              </label>
              <label className="flex min-h-14 items-center justify-between gap-4 rounded-xl border border-brand-border p-3">
                <span><span className="block text-sm font-bold">Private journal lock</span><span className="mt-1 block text-xs text-brand-text-muted">Require your app PIN or biometrics whenever this journal is opened.</span></span>
                <input type="checkbox" checked={locked} onChange={event => setLocked(event.target.checked)} className="h-5 w-5 accent-brand-sage" />
              </label>
            </section>

            <button type="button" aria-expanded={customizing} onClick={() => setCustomizing(value => !value)} className="surface-card flex min-h-14 w-full items-center justify-between p-4 text-left text-sm font-bold">
              Customize appearance (optional)<span>{customizing ? 'Hide' : 'Open'}</span>
            </button>

            {customizing && (
              <section className="surface-card space-y-6 p-5">
                <div>
                  <p className="text-sm font-bold">Cover image</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <AppButton onClick={() => coverInputRef.current?.click()}><ImagePlus className="h-4 w-4" />{coverImage ? 'Change image' : 'Choose image'}</AppButton>
                    {coverImage && <AppButton tone="quiet" onClick={() => setCoverImage(undefined)}><Trash2 className="h-4 w-4" />Remove</AppButton>}
                    <input ref={coverInputRef} type="file" accept="image/*" onChange={uploadCover} className="hidden" />
                  </div>
                </div>
                <fieldset><legend className="text-sm font-bold">Cover color</legend><div className="mt-2 grid grid-cols-6 gap-2">{PREDEFINED_COLORS.map(option => <button key={option.hex} type="button" aria-label={`Use ${option.name} cover color`} aria-pressed={color === option.hex} disabled={Boolean(coverImage)} onClick={() => setColor(option.hex)} className="aspect-square rounded-xl border border-black/10 disabled:opacity-35" style={{ backgroundColor: option.hex }}>{color === option.hex && !coverImage && <Check className="mx-auto h-5 w-5 text-white" />}</button>)}</div></fieldset>
                <fieldset><legend className="text-sm font-bold">Cover icon</legend><div className="mt-2 flex flex-wrap gap-2">{EMOJI_OPTIONS.map(option => <button key={option} type="button" aria-label={`Use ${option} as journal icon`} aria-pressed={emoji === option} onClick={() => setEmoji(option)} className={`h-11 w-11 rounded-xl text-xl ${emoji === option ? 'border-2 border-brand-sage bg-brand-sage-light' : 'border border-brand-border'}`}>{option}</button>)}</div></fieldset>
                <fieldset><legend className="text-sm font-bold">Foil stamps ({foilIcons.length}/4)</legend><div className="mt-2 flex flex-wrap gap-2">{FOIL_ICON_OPTIONS.map(option => { const selected = foilIcons.includes(option); return <button key={option} type="button" aria-label={`${selected ? 'Remove' : 'Add'} ${option} foil stamp`} aria-pressed={selected} onClick={() => setFoilIcons(current => selected ? current.filter(item => item !== option) : current.length < 4 ? [...current, option] : current)} className={`h-11 w-11 rounded-xl text-lg ${selected ? 'border-2 border-amber-500 bg-amber-50' : 'border border-brand-border'}`}>{option}</button>; })}</div></fieldset>
              </section>
            )}
          </main>
        </div>
      </form>
    );
  }

  return (
    <div className="space-y-6 pb-20">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div><h1 className="font-serif-diary text-3xl font-semibold text-brand-plum dark:text-brand-text md:text-4xl">Journals</h1><p className="mt-1 text-sm text-brand-text-muted">{diaries.length} journals · {totalEntries} entries{latest ? ` · Updated ${latest.lastUpdated}` : ''}</p></div>
        <AppButton tone="primary" onClick={() => setCreating(true)}><Plus className="h-4 w-4" />New Journal</AppButton>
      </header>

      <section className="surface-card grid gap-3 p-3 md:grid-cols-[minmax(220px,1fr)_auto_auto_auto]">
        <label className="relative"><span className="sr-only">Search journals</span><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-brand-text-muted" /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search journals" className="min-h-11 w-full rounded-xl border border-brand-border bg-brand-bg/40 pl-10 pr-3 text-base outline-none focus:border-brand-sage" /></label>
        <label className="sr-only" htmlFor="journal-sort">Sort journals</label><select id="journal-sort" value={sortBy} onChange={event => setSortBy(event.target.value as typeof sortBy)} className="min-h-11 rounded-xl border border-brand-border bg-brand-card-bg px-3 text-sm font-bold"><option value="updated">Recently updated</option><option value="name">Name</option><option value="entries">Most entries</option><option value="created">Newest created</option></select>
        <label className="sr-only" htmlFor="journal-filter">Filter journals</label><select id="journal-filter" value={filterBy} onChange={event => setFilterBy(event.target.value as typeof filterBy)} className="min-h-11 rounded-xl border border-brand-border bg-brand-card-bg px-3 text-sm font-bold"><option value="all">All journals</option><option value="locked">Locked</option><option value="unlocked">Unlocked</option><option value="empty">Empty</option></select>
        <div className="flex rounded-xl border border-brand-border p-1"><IconButton label="Gallery view" aria-pressed={viewMode === 'compact'} onClick={() => setMode('compact')} className={viewMode === 'compact' ? 'bg-brand-sage-light' : ''}><LayoutGrid className="h-4 w-4" /></IconButton><IconButton label="List view" aria-pressed={viewMode === 'list'} onClick={() => setMode('list')} className={viewMode === 'list' ? 'bg-brand-sage-light' : ''}><List className="h-4 w-4" /></IconButton></div>
      </section>

      {visible.length === 0 ? <div className="surface-card p-12 text-center"><p className="font-serif-diary text-2xl font-semibold">No matching journals</p><p className="mt-2 text-sm text-brand-text-muted">Try another search or filter.</p></div> : viewMode === 'list' ? (
        <section className="surface-card divide-y divide-brand-border overflow-hidden">{visible.map(diary => <button key={diary.id} type="button" data-testid="diary-card" onClick={() => onNavigate('diaries', 'diaryDetail', diary.id)} className="flex w-full items-center gap-4 p-4 text-left hover:bg-brand-sage-light/35"><JournalCover diary={diary} variant="thumbnail" showTitle={false} /><span className="min-w-0 flex-1"><span className="block truncate font-serif-diary text-lg font-bold">{diary.name}</span><span className="text-xs text-brand-text-muted">{diary.entryCount} entries · {diary.lastUpdated}</span></span>{diary.isLocked && <Lock className="h-4 w-4 text-brand-text-muted" />}</button>)}</section>
      ) : (
        <section className="grid grid-cols-2 gap-5 sm:grid-cols-3 xl:grid-cols-4">{visible.map(diary => <button key={diary.id} type="button" data-testid="diary-card" onClick={() => onNavigate('diaries', 'diaryDetail', diary.id)} className="group text-left"><JournalCover diary={diary} variant="full" className="w-full transition-shadow group-hover:shadow-lg" /><span className="mt-2 block truncate text-sm font-bold">{diary.name}</span><span className="text-xs text-brand-text-muted">{diary.entryCount} entries · {diary.lastUpdated}</span></button>)}</section>
      )}
    </div>
  );
}
