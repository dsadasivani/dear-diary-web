import React, { useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { 
  Search, BookOpen, FileText, Image, Calendar, Tag, ArrowRight, X, Filter, Download, RefreshCw
} from 'lucide-react';
import { AppSettings, Diary, Entry, Note, PartitionHydrationState, ResponsiveLayout } from '../types';
import { getTagsForSettings } from '../domain/appSettings';

interface SearchScreenProps {
  diaries: Diary[];
  entries: Entry[];
  notes: Note[];
  settings: AppSettings;
  layout?: ResponsiveLayout;
  initialQuery?: string;
  archiveMonths?: PartitionHydrationState[];
  onHydrateArchiveMonth?: (partitionKey: string) => void | Promise<void>;
  onHydrateAllArchiveMonths?: () => void | Promise<void>;
  onNavigate: (tab: string, screen?: string, diaryId?: string, entryId?: string) => void;
  onEditNote: (note: Note) => void;
}

const formatArchiveRetryStatus = (archiveState?: PartitionHydrationState): string => {
  if (!archiveState || archiveState.status !== 'failed') return '';
  if (archiveState.nextRetryAt && archiveState.nextRetryAt > Date.now()) {
    return `Background restore will retry after ${new Date(archiveState.nextRetryAt).toLocaleString()}. Manual retry is available now.`;
  }
  return 'The previous archive restore failed. Manual retry is available now.';
};

export default function SearchScreen({
  diaries,
  entries,
  notes,
  settings,
  layout = 'mobile',
  initialQuery,
  archiveMonths = [],
  onHydrateArchiveMonth,
  onHydrateAllArchiveMonths,
  onNavigate,
  onEditNote
}: SearchScreenProps) {
  const availableTags = getTagsForSettings(settings);
  const [query, setQuery] = useState<string>('');
  const [selectedResultId, setSelectedResultId] = useState<string>('');
  
  // Filter states
  const [selectedSource, setSelectedSource] = useState<'all' | 'diaries' | 'notes'>('all');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [hasPhotos, setHasPhotos] = useState<boolean>(false);
  const [fromDate, setFromDate] = useState<string>('');
  const [toDate, setToDate] = useState<string>('');
  const [showFilters, setShowFilters] = useState<boolean>(false);
  const [restoringArchiveKey, setRestoringArchiveKey] = useState<string>('');
  const [restoringAllArchives, setRestoringAllArchives] = useState<boolean>(false);
  const [archiveRestoreError, setArchiveRestoreError] = useState<string>('');
  const unloadedArchiveMonths = archiveMonths.filter(month => month.status !== 'hydrated');
  const failedArchiveMonths = unloadedArchiveMonths.filter(month => month.status === 'failed');
  const nextRestorableArchiveMonth = unloadedArchiveMonths.find(month => month.status !== 'hydrating');
  const nextRestorableArchiveStatus = formatArchiveRetryStatus(nextRestorableArchiveMonth);
  const restorableArchiveMonths = unloadedArchiveMonths.filter(month => month.status !== 'hydrating');

  const [results, setResults] = useState<{
    type: 'entry' | 'note';
    id: string;
    title: string;
    body: string;
    date: string;
    tags: string[];
    diaryName?: string;
    photoCount?: number;
    rawObj: any;
  }[]>([]);

  useEffect(() => {
    if (initialQuery !== undefined) {
      setQuery(initialQuery);
    }
  }, [initialQuery]);

  // Real-time search filter triggers
  useEffect(() => {
    let list: typeof results = [];

    // 1. Process diary entries
    if (selectedSource === 'all' || selectedSource === 'diaries') {
      entries.forEach(entry => {
        const diaryObj = diaries.find(d => d.id === entry.diaryId);
        list.push({
          type: 'entry',
          id: entry.id,
          title: entry.title,
          body: entry.body,
          date: entry.date,
          tags: entry.tags,
          diaryName: diaryObj ? diaryObj.name : 'Unknown Diary',
          photoCount: entry.photoCount,
          rawObj: entry
        });
      });
    }

    // 2. Process quick notes
    if (selectedSource === 'all' || selectedSource === 'notes') {
      notes.forEach(note => {
        // Formulate a clean timestamp date YYYY-MM-DD
        const noteDateStr = new Date(note.updatedAt).toISOString().split('T')[0];
        list.push({
          type: 'note',
          id: note.id,
          title: note.title,
          body: note.body,
          date: noteDateStr,
          tags: note.tags,
          diaryName: undefined,
          photoCount: 0,
          rawObj: note
        });
      });
    }

    // 3. Filter by text query (case-insensitive)
    if (query.trim()) {
      const q = query.toLowerCase().trim();
      list = list.filter(item => 
        item.title.toLowerCase().includes(q) || 
        item.body.toLowerCase().includes(q)
      );
    }

    // 4. Filter by selected tags (must contain all selected tags)
    if (selectedTags.length > 0) {
      list = list.filter(item => 
        selectedTags.every(tag => item.tags.includes(tag))
      );
    }

    // 5. Filter by "has photos" toggle
    if (hasPhotos) {
      list = list.filter(item => item.type === 'entry' && (item.photoCount || 0) > 0);
    }

    // 6. Filter by date ranges
    if (fromDate) {
      list = list.filter(item => item.date >= fromDate);
    }
    if (toDate) {
      list = list.filter(item => item.date <= toDate);
    }

    // Sort: Newest date first
    list.sort((a, b) => b.date.localeCompare(a.date));

    setResults(list);
  }, [query, selectedSource, selectedTags, hasPhotos, fromDate, toDate, entries, notes, diaries]);

  const handleTagToggle = (tag: string) => {
    if (selectedTags.includes(tag)) {
      setSelectedTags(prev => prev.filter(t => t !== tag));
    } else {
      setSelectedTags(prev => [...prev, tag]);
    }
  };

  const clearAllFilters = () => {
    setSelectedSource('all');
    setSelectedTags([]);
    setHasPhotos(false);
    setFromDate('');
    setToDate('');
    setQuery('');
  };

  const handleResultClick = (item: typeof results[0]) => {
    if (item.type === 'entry') {
      onNavigate('diaries', 'diaryDetail', item.rawObj.diaryId, item.id);
    } else {
      onEditNote(item.rawObj);
    }
  };

  const selectedResult = results.find(item => item.id === selectedResultId) || results[0] || null;

  if (layout === 'desktop') {
    const filterPanel = (
      <aside className="space-y-6 rounded-[26px] border border-brand-border bg-white/68 p-5 shadow-[0_18px_55px_rgba(62,36,41,0.07)] dark:bg-brand-card-bg/60 xl:sticky xl:top-6 xl:max-h-[calc(100vh-9rem)] xl:overflow-y-auto 2xl:p-6">
        <div>
          <h2 className="text-sm font-bold uppercase tracking-[0.18em] text-brand-plum dark:text-brand-text">Source</h2>
          <div className="mt-4 space-y-2">
            {(['all', 'diaries', 'notes'] as const).map(source => (
              <button
                key={source}
                type="button"
                onClick={() => setSelectedSource(source)}
                className={`flex w-full items-center justify-between rounded-xl border px-4 py-3 text-left text-sm font-bold capitalize transition-all ${
                  selectedSource === source
                    ? 'border-brand-sage bg-white text-brand-plum shadow-[0_8px_24px_rgba(62,36,41,0.07)]'
                    : 'border-brand-border bg-brand-bg/45 text-brand-text-muted hover:bg-white'
                }`}
              >
                <span>{source === 'all' ? 'All Entries' : source}</span>
                <span className={`h-3 w-3 rounded-full border ${selectedSource === source ? 'border-brand-sage bg-brand-sage' : 'border-brand-border'}`} />
              </button>
            ))}
          </div>
        </div>

        <div>
          <h2 className="text-sm font-bold uppercase tracking-[0.18em] text-brand-plum dark:text-brand-text">Refine by tags</h2>
          <div className="mt-4 flex max-h-40 flex-wrap gap-2 overflow-y-auto">
            {availableTags.map(tag => {
              const isSelected = selectedTags.includes(tag);
              return (
                <button
                  key={tag}
                  type="button"
                  onClick={() => handleTagToggle(tag)}
                  className={`rounded-full px-3 py-1.5 text-sm font-bold transition-all ${isSelected ? 'bg-brand-sage text-white' : 'bg-brand-sage-light text-brand-sage-dark hover:bg-brand-blush-light'}`}
                >
                  #{tag}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <h2 className="text-sm font-bold uppercase tracking-[0.18em] text-brand-plum dark:text-brand-text">Date range</h2>
          <div className="mt-4 space-y-3">
            <input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} className="w-full rounded-xl border border-brand-border bg-white/70 px-4 py-3 text-sm font-bold text-brand-plum outline-none" />
            <input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} className="w-full rounded-xl border border-brand-border bg-white/70 px-4 py-3 text-sm font-bold text-brand-plum outline-none" />
          </div>
        </div>

        <label className="flex cursor-pointer items-center justify-between rounded-xl border border-brand-border bg-brand-bg/45 px-4 py-3">
          <span className="text-sm font-bold text-brand-plum dark:text-brand-text">Requires Photos</span>
          <input type="checkbox" checked={hasPhotos} onChange={(event) => setHasPhotos(event.target.checked)} className="h-5 w-5 accent-brand-sage" />
        </label>

        <button type="button" onClick={clearAllFilters} className="w-full rounded-full border border-brand-border bg-white/65 px-4 py-3 text-sm font-bold text-brand-sage hover:bg-white">
          Clear Filters
        </button>
      </aside>
    );

    return (
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[260px_minmax(0,1fr)] 2xl:grid-cols-[280px_minmax(0,1fr)_320px] 2xl:gap-7">
        {filterPanel}

        <main className="min-w-0 space-y-6">
          <header className="space-y-4">
            <h1 className="font-serif-diary text-4xl font-semibold tracking-tight text-brand-plum dark:text-brand-text xl:text-5xl">Global Search</h1>
            <div className="relative">
              <Search className="absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-brand-text-muted" />
              <input
                type="text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search thoughts, memories, dreams..."
                className="w-full rounded-full border border-brand-border bg-white/72 py-3.5 pl-12 pr-4 text-base font-semibold text-brand-plum outline-none transition-all focus:border-brand-sage focus:bg-white focus:shadow-[0_10px_34px_rgba(62,36,41,0.08)] dark:bg-brand-card-bg/70 dark:text-brand-text"
              />
            </div>
            <p className="text-lg text-brand-text-muted">
              Showing <strong className="text-brand-plum dark:text-brand-text">{results.length}</strong> result{results.length === 1 ? '' : 's'}
              {query.trim() ? ` for "${query.trim()}"` : ''}
            </p>
          </header>

          {unloadedArchiveMonths.length > 0 && (
            <div className="rounded-2xl border border-brand-sage/20 bg-brand-sage-light/20 px-4 py-3 text-xs text-brand-sage-dark">
              Searching downloaded memories first. Restore older archive months to include more results.
            </div>
          )}

          <section className="grid grid-cols-1 gap-4 2xl:grid-cols-2">
            {results.map(item => {
              const isSelected = selectedResult?.id === item.id;
              return (
                <button
                  key={`${item.type}-${item.id}`}
                  type="button"
                  onClick={() => {
                    const hasPreviewRail = typeof window !== 'undefined' && window.matchMedia('(min-width: 1536px)').matches;
                    if (hasPreviewRail) {
                      setSelectedResultId(item.id);
                    } else {
                      handleResultClick(item);
                    }
                  }}
                  onDoubleClick={() => handleResultClick(item)}
                  className={`min-h-[188px] rounded-[24px] border bg-white/74 p-5 text-left shadow-[0_12px_35px_rgba(62,36,41,0.06)] transition-all hover:-translate-y-0.5 hover:bg-white hover:shadow-[0_18px_45px_rgba(62,36,41,0.09)] dark:bg-brand-card-bg/70 ${
                    isSelected ? 'border-brand-sage ring-2 ring-brand-sage/15' : 'border-brand-border'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <span className={`rounded-full px-3 py-1 text-xs font-bold ${item.type === 'entry' ? 'bg-brand-sage-light text-brand-sage-dark' : 'bg-brand-blush-light text-brand-pink-dark'}`}>
                      {item.type === 'entry' ? 'Journal Entry' : 'Quick Note'}
                    </span>
                    <span className="text-xs font-bold text-brand-text-muted">{item.date}</span>
                  </div>
                  <h2 className="mt-5 font-serif-diary text-2xl font-bold text-brand-plum dark:text-brand-text">{item.title}</h2>
                  <p className="mt-3 line-clamp-4 text-base leading-relaxed text-brand-plum/80 dark:text-brand-text/80">{item.body.replace(/<[^>]*>/g, ' ')}</p>
                  <div className="mt-4 flex flex-wrap gap-1.5">
                    {item.tags.slice(0, 4).map(tag => (
                      <span key={tag} className="rounded-full bg-brand-bg px-2 py-0.5 text-[10px] font-bold text-brand-sage-dark">
                        #{tag}
                      </span>
                    ))}
                  </div>
                </button>
              );
            })}

            {results.length === 0 && (
              <div className="rounded-2xl border border-dashed border-brand-border bg-white/45 p-12 text-center 2xl:col-span-2">
                <Search className="mx-auto h-12 w-12 text-brand-sage opacity-60" />
                <h2 className="mt-4 font-serif-diary text-3xl font-bold text-brand-plum dark:text-brand-text">No results found</h2>
                <p className="mt-2 text-sm text-brand-text-muted">Try adjusting text, filters, dates, or tags.</p>
              </div>
            )}
          </section>
        </main>

        <aside className="hidden rounded-[28px] border border-brand-border bg-white/76 p-6 shadow-[0_18px_55px_rgba(62,36,41,0.08)] dark:bg-brand-card-bg/72 2xl:sticky 2xl:top-8 2xl:block 2xl:max-h-[calc(100vh-10rem)] 2xl:overflow-y-auto">
          {selectedResult ? (
            <div>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-bold uppercase tracking-[0.2em] text-brand-sage">
                    {selectedResult.type === 'entry' ? 'Journal Entry' : 'Quick Note'}
                  </p>
                  <h2 className="mt-4 font-serif-diary text-3xl font-bold text-brand-plum dark:text-brand-text">{selectedResult.title}</h2>
                  <p className="mt-2 text-sm font-bold text-brand-text-muted">{selectedResult.date}</p>
                </div>
                <button type="button" onClick={() => setSelectedResultId('')} className="rounded-full p-2 text-brand-text-muted hover:bg-brand-blush-light">
                  <X className="h-5 w-5" />
                </button>
              </div>

              <div className="mt-7 flex flex-wrap gap-2">
                {selectedResult.tags.map(tag => (
                  <span key={tag} className="rounded-full bg-brand-sage-light px-3 py-1.5 text-sm font-bold text-brand-sage-dark">
                    #{tag}
                  </span>
                ))}
              </div>

              <p className="mt-7 whitespace-pre-line text-base leading-relaxed text-brand-plum/90 dark:text-brand-text/90">
                {selectedResult.body.replace(/<[^>]*>/g, ' ')}
              </p>

              <button
                type="button"
                onClick={() => handleResultClick(selectedResult)}
                className="mt-8 inline-flex w-full items-center justify-center gap-2 rounded-full bg-brand-sage px-5 py-3 text-sm font-bold text-white hover:bg-brand-sage-dark"
              >
                Open {selectedResult.type === 'entry' ? 'Entry' : 'Note'}
                <ArrowRight className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <div className="flex min-h-[420px] flex-col items-center justify-center text-center">
              <Search className="h-10 w-10 text-brand-sage" />
              <h2 className="mt-4 font-serif-diary text-2xl font-bold text-brand-plum dark:text-brand-text">Select a result</h2>
              <p className="mt-2 text-sm text-brand-text-muted">Preview a memory before opening it.</p>
            </div>
          )}
        </aside>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 font-sans">
      {/* Header */}
      <header className="bg-brand-bg/95 backdrop-blur-md sticky top-0 py-3 z-30 flex flex-col gap-3">
        <div className="flex justify-between items-center">
          <h1 className="font-serif-diary text-3xl text-brand-plum tracking-tight font-bold">Search Sanctuary</h1>
          <button 
            onClick={() => setShowFilters(!showFilters)}
            className={`p-2.5 rounded-full border transition-all flex items-center gap-1.5 text-xs font-bold ${
              showFilters || selectedTags.length > 0 || hasPhotos || fromDate || toDate
                ? 'bg-brand-pink text-white border-brand-pink shadow-sm'
                : 'bg-brand-card-bg text-brand-sage border-brand-border hover:bg-brand-blush-light dark:hover:bg-brand-blush-light/10'
            }`}
          >
            <Filter className="w-4 h-4" />
            Filters
            {(selectedTags.length > 0 || hasPhotos || fromDate || toDate) && (
              <span className="w-2 h-2 bg-white rounded-full" />
            )}
          </button>
        </div>

        {/* Dynamic Text Input Box */}
        <div className="relative">
          <Search className="absolute left-4 top-3.5 w-4 h-4 text-brand-sage/60" />
          <input 
            type="text" 
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search keywords in diaries or notes..."
            className="w-full bg-brand-card-bg text-sm text-brand-plum placeholder-brand-sage/50 pl-11 pr-4 py-3 rounded-2xl border border-brand-border focus:outline-none focus:ring-1 focus:ring-brand-sage journal-shadow"
          />
          {query && (
            <button 
              onClick={() => setQuery('')}
              className="absolute right-4 top-3.5 text-brand-sage hover:text-brand-plum"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </header>

      {/* Slide-down filter panel */}
      {showFilters && (
        <motion.div 
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          className="bg-brand-card-bg p-5 rounded-3xl border border-brand-border journal-shadow flex flex-col gap-4 overflow-hidden"
        >
          {/* Source filter */}
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] font-bold text-brand-sage uppercase tracking-wider">Search Source</span>
            <div className="grid grid-cols-3 gap-2">
              {(['all', 'diaries', 'notes'] as const).map(source => (
                <button
                  key={source}
                  onClick={() => setSelectedSource(source)}
                  className={`py-2 rounded-xl text-xs font-bold uppercase tracking-wider transition-all border ${
                    selectedSource === source 
                      ? 'bg-brand-sage-light text-brand-sage-dark border-brand-sage' 
                      : 'bg-brand-bg text-brand-sage border-brand-rose-light/50 hover:bg-brand-blush-light'
                  }`}
                >
                  {source}
                </button>
              ))}
            </div>
          </div>

          {/* Tag multiselect picker */}
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] font-bold text-brand-sage uppercase tracking-wider">Has Specific Tags</span>
            <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto no-scrollbar">
              {availableTags.map(tag => {
                const isSelected = selectedTags.includes(tag);
                return (
                  <button
                    key={tag}
                    onClick={() => handleTagToggle(tag)}
                    className={`px-3 py-1.5 rounded-full text-[10px] font-semibold transition-all border ${
                      isSelected 
                        ? 'bg-brand-pink text-white border-brand-pink' 
                        : 'bg-brand-bg text-brand-sage-dark border-brand-rose-light/40 hover:bg-brand-rose-light/25'
                    }`}
                  >
                    #{tag}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Date from and to selectors */}
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1">
              <span className="text-[10px] font-bold text-brand-sage uppercase tracking-wider">From Date</span>
              <input 
                type="date" 
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                className="bg-brand-bg border border-brand-rose-light text-xs font-serif-diary p-2 rounded-xl focus:outline-none"
              />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[10px] font-bold text-brand-sage uppercase tracking-wider">To Date</span>
              <input 
                type="date" 
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                className="bg-brand-bg border border-brand-rose-light text-xs font-serif-diary p-2 rounded-xl focus:outline-none"
              />
            </div>
          </div>

          {/* Photo requirement switch */}
          <div className="flex justify-between items-center py-1">
            <div className="flex items-center gap-1.5 text-brand-plum">
              <Image className="w-4 h-4 text-brand-sage" />
              <span className="text-xs font-bold text-brand-plum">Requires Attached Photos</span>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input 
                type="checkbox" 
                checked={hasPhotos}
                onChange={(e) => setHasPhotos(e.target.checked)}
                className="sr-only peer" 
              />
              <div className="w-11 h-6 bg-brand-sage-light/50 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-brand-sage-light after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-brand-sage" />
            </label>
          </div>

          {/* Clear filters trigger */}
          <button
            onClick={clearAllFilters}
            className="w-full py-2 bg-brand-blush-light text-brand-pink-dark rounded-xl text-xs font-bold hover:bg-brand-blush-dark transition-colors"
          >
            Clear Active Filters
          </button>
        </motion.div>
      )}

      {/* Results Header count summary */}
      <div className="flex justify-between items-center">
        <span className="text-xs text-brand-sage font-bold uppercase tracking-wider">
          {results.length} results found
        </span>
      </div>

      {unloadedArchiveMonths.length > 0 && (
        <div className="rounded-2xl border border-brand-sage/20 bg-brand-sage-light/20 px-4 py-3 text-xs text-brand-sage-dark">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p>
              Searching downloaded memories first. {unloadedArchiveMonths.length} older archive month{unloadedArchiveMonths.length === 1 ? '' : 's'} will appear after restore or when opened.
              {failedArchiveMonths.length > 0 && (
                <> {failedArchiveMonths.length} month{failedArchiveMonths.length === 1 ? '' : 's'} need retry.</>
              )}
            </p>
            <div className="flex shrink-0 flex-wrap gap-2">
              {onHydrateArchiveMonth && nextRestorableArchiveMonth && (
                <button
                  type="button"
                  disabled={restoringAllArchives || restoringArchiveKey === nextRestorableArchiveMonth.partitionKey}
                  onClick={async () => {
                    setRestoringArchiveKey(String(nextRestorableArchiveMonth.partitionKey));
                    setArchiveRestoreError('');
                    try {
                      await onHydrateArchiveMonth(String(nextRestorableArchiveMonth.partitionKey));
                    } catch (error: any) {
                      setArchiveRestoreError(error?.message || 'Could not restore this archive month.');
                    } finally {
                      setRestoringArchiveKey('');
                    }
                  }}
                  className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-full bg-brand-sage px-3 py-1.5 text-[10px] font-extrabold uppercase tracking-widest text-white transition-all hover:bg-brand-sage-dark disabled:cursor-wait disabled:bg-brand-sage/60"
                >
                  {restoringArchiveKey === nextRestorableArchiveMonth.partitionKey ? (
                    <RefreshCw className="h-3 w-3 animate-spin" />
                  ) : (
                    <Download className="h-3 w-3" />
                  )}
                  {restoringArchiveKey === nextRestorableArchiveMonth.partitionKey
                    ? 'Restoring'
                    : `${nextRestorableArchiveMonth.status === 'failed' ? 'Retry' : 'Restore'} ${String(nextRestorableArchiveMonth.partitionKey).replace('month:', '')}`}
                </button>
              )}
              {onHydrateAllArchiveMonths && restorableArchiveMonths.length > 1 && (
                <button
                  type="button"
                  disabled={restoringAllArchives || Boolean(restoringArchiveKey)}
                  onClick={async () => {
                    setRestoringAllArchives(true);
                    setArchiveRestoreError('');
                    try {
                      await onHydrateAllArchiveMonths();
                    } catch (error: any) {
                      setArchiveRestoreError(error?.message || 'Could not restore all archive months.');
                    } finally {
                      setRestoringAllArchives(false);
                    }
                  }}
                  className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-full border border-brand-sage/40 bg-white/70 px-3 py-1.5 text-[10px] font-extrabold uppercase tracking-widest text-brand-sage-dark transition-all hover:bg-brand-sage-light/40 disabled:cursor-wait disabled:opacity-60"
                >
                  {restoringAllArchives ? (
                    <RefreshCw className="h-3 w-3 animate-spin" />
                  ) : (
                    <Download className="h-3 w-3" />
                  )}
                  {restoringAllArchives ? 'Restoring archive' : 'Restore all on Wi-Fi'}
                </button>
              )}
            </div>
          </div>
          {nextRestorableArchiveStatus && (
            <p className="mt-2 text-[11px] font-semibold text-brand-sage-dark">
              {nextRestorableArchiveStatus}
            </p>
          )}
          {archiveRestoreError && <p className="mt-2 text-[11px] font-bold text-red-600">{archiveRestoreError}</p>}
        </div>
      )}

      {/* Results List */}
      <div className="flex flex-col gap-4">
        {results.map(item => (
          <article 
            key={`${item.type}-${item.id}`}
            onClick={() => handleResultClick(item)}
            className="bg-brand-card-bg p-4 rounded-2xl border border-brand-border hover:border-brand-pink/40 journal-shadow cursor-pointer flex flex-col gap-2 transition-all hover:translate-x-0.5"
          >
            <div className="flex justify-between items-start">
              <span className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full ${
                item.type === 'entry' 
                  ? 'bg-brand-sage-light/30 text-brand-sage-dark' 
                  : 'bg-brand-blush-light text-brand-pink-dark'
              }`}>
                {item.type === 'entry' ? <BookOpen className="w-3 h-3" /> : <FileText className="w-3 h-3" />}
                {item.type === 'entry' ? `Diary: ${item.diaryName}` : 'Quick Note'}
              </span>
              <span className="text-[10px] text-brand-sage font-semibold">{item.date}</span>
            </div>

            <h3 className="font-serif-diary font-bold text-brand-plum text-sm">{item.title}</h3>
            <p className="text-xs text-brand-plum/80 leading-relaxed line-clamp-2">{item.body}</p>

            <div className="flex justify-between items-center border-t border-brand-rose-light/30 pt-2.5 mt-1.5">
              <div className="flex flex-wrap gap-1">
                {item.tags.map(tag => (
                  <span key={tag} className="text-[9px] font-bold uppercase tracking-widest text-brand-sage-dark bg-brand-sage-light/10 border border-brand-sage-light/25 px-2 py-0.5 rounded-full">
                    #{tag}
                  </span>
                ))}
              </div>
              <span className="text-[9px] font-bold text-brand-pink hover:underline uppercase tracking-wider flex items-center gap-0.5">
                View detail
                <ArrowRight className="w-2.5 h-2.5" />
              </span>
            </div>
          </article>
        ))}

        {/* Empty State */}
        {results.length === 0 && (
          <div className="flex flex-col items-center justify-center text-center py-20 px-6 gap-3">
            <Search className="w-12 h-12 text-brand-sage opacity-50" />
            <h3 className="font-serif-diary text-lg font-bold text-brand-plum">No results found</h3>
            <p className="text-xs text-brand-sage max-w-xs">
              Try adjusting your text, source filters, date ranges, or tag multiselections.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
