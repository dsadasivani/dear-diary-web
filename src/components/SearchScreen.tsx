import React, { useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { 
  Search, BookOpen, FileText, Image, Calendar, Tag, ArrowRight, X, Filter, Download, RefreshCw
} from 'lucide-react';
import { AppSettings, Diary, Entry, Note, PartitionHydrationState } from '../types';
import { getTagsForSettings } from '../domain/appSettings';

interface SearchScreenProps {
  diaries: Diary[];
  entries: Entry[];
  notes: Note[];
  settings: AppSettings;
  archiveMonths?: PartitionHydrationState[];
  onHydrateArchiveMonth?: (partitionKey: string) => void | Promise<void>;
  onNavigate: (tab: string, screen?: string, diaryId?: string, entryId?: string) => void;
  onEditNote: (note: Note) => void;
}

export default function SearchScreen({
  diaries,
  entries,
  notes,
  settings,
  archiveMonths = [],
  onHydrateArchiveMonth,
  onNavigate,
  onEditNote
}: SearchScreenProps) {
  const availableTags = getTagsForSettings(settings);
  const [query, setQuery] = useState<string>('');
  
  // Filter states
  const [selectedSource, setSelectedSource] = useState<'all' | 'diaries' | 'notes'>('all');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [hasPhotos, setHasPhotos] = useState<boolean>(false);
  const [fromDate, setFromDate] = useState<string>('');
  const [toDate, setToDate] = useState<string>('');
  const [showFilters, setShowFilters] = useState<boolean>(false);
  const [restoringArchiveKey, setRestoringArchiveKey] = useState<string>('');
  const [archiveRestoreError, setArchiveRestoreError] = useState<string>('');
  const unloadedArchiveMonths = archiveMonths.filter(month => month.status !== 'hydrated');
  const nextRestorableArchiveMonth = unloadedArchiveMonths.find(month => month.status !== 'hydrating');

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
            </p>
            {onHydrateArchiveMonth && nextRestorableArchiveMonth && (
              <button
                type="button"
                disabled={restoringArchiveKey === nextRestorableArchiveMonth.partitionKey}
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
                  : `Restore ${String(nextRestorableArchiveMonth.partitionKey).replace('month:', '')}`}
              </button>
            )}
          </div>
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
