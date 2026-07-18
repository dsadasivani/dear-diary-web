import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { motion, useAnimationControls, useReducedMotion } from 'motion/react';
import {
  ArrowRight,
  BookOpen,
  Download,
  FileText,
  Filter,
  Image,
  RefreshCw,
  Search,
} from 'lucide-react';
import type { AppSettings, Note, PartitionHydrationState, ResponsiveLayout } from '../types';
import { getTagsForSettings } from '../domain/appSettings';
import { richTextHtmlToPlainText } from '../domain/richTextSanitizer';
import { useScreenPerformance } from '../hooks/useScreenPerformance';
import { diaryRepository } from '../repositories';
import type { SettingsSection } from './AppSettingsScreen';
import { AppButton, SearchField, StatusNotice } from './UiPrimitives';
import { BottomSheet } from './ui/BottomSheet';
import { EmptyState, LoadingSkeleton } from './ui/Feedback';
import { motionTransitions } from './ui/motion';

interface SearchScreenProps {
  settings: AppSettings;
  layout?: ResponsiveLayout;
  initialQuery?: string;
  excludeDiaryIds?: string[];
  archiveMonths?: PartitionHydrationState[];
  onHydrateArchiveMonth?: (partitionKey: string) => void | Promise<void>;
  onHydrateAllArchiveMonths?: () => void | Promise<void>;
  onOpenSettingsSection?: (section: SettingsSection) => void;
  onNavigate: (tab: string, screen?: string, diaryId?: string, entryId?: string) => void;
  onEditNote: (note: Note) => void;
}

type SearchResultItem = {
  type: 'entry' | 'note';
  id: string;
  title: string;
  body: string;
  date: string;
  tags: string[];
  diaryName?: string;
  photoCount?: number;
  rawObj: any;
};

const formatArchiveRetryStatus = (archiveState?: PartitionHydrationState): string => {
  if (!archiveState || archiveState.status !== 'failed') return '';
  if (archiveState.nextRetryAt && archiveState.nextRetryAt > Date.now())
    return `Background restore will retry after ${new Date(archiveState.nextRetryAt).toLocaleString()}. Manual retry is available now.`;
  return 'The previous archive restore failed. Manual retry is available now.';
};

const highlightMatch = (value: string, query: string): ReactNode => {
  const needle = query.trim();
  if (!needle) return value;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return value.split(new RegExp(`(${escaped})`, 'ig')).map((part, index) =>
    part.toLocaleLowerCase() === needle.toLocaleLowerCase() ? (
      <mark
        key={index}
        className="rounded-sm bg-amber-200/65 px-0.5 text-inherit dark:bg-amber-500/30"
      >
        {part}
      </mark>
    ) : (
      part
    ),
  );
};

export default function SearchScreen({
  settings,
  layout = 'mobile',
  initialQuery,
  excludeDiaryIds = [],
  archiveMonths = [],
  onHydrateArchiveMonth,
  onHydrateAllArchiveMonths,
  onOpenSettingsSection,
  onNavigate,
  onEditNote,
}: SearchScreenProps) {
  useScreenPerformance('search');
  const searchFieldRef = useRef<HTMLDivElement>(null);
  const searchFieldAnimation = useAnimationControls();
  const prefersReducedMotion = useReducedMotion();
  const availableTags = getTagsForSettings(settings);
  const [query, setQuery] = useState('');
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [selectedResultId, setSelectedResultId] = useState('');
  const [selectedSource, setSelectedSource] = useState<'all' | 'diaries' | 'notes'>('all');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [hasPhotos, setHasPhotos] = useState(false);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [diaryNamesById, setDiaryNamesById] = useState<Record<string, string>>({});
  const [restoringArchiveKey, setRestoringArchiveKey] = useState('');
  const [restoringAllArchives, setRestoringAllArchives] = useState(false);
  const [archiveRestoreError, setArchiveRestoreError] = useState('');
  const [results, setResults] = useState<SearchResultItem[]>([]);
  const excludeDiaryKey = excludeDiaryIds.join('|');
  const unloadedArchiveMonths = archiveMonths.filter((month) => month.status !== 'hydrated');
  const failedArchiveMonths = unloadedArchiveMonths.filter((month) => month.status === 'failed');
  const nextRestorableArchiveMonth = unloadedArchiveMonths.find(
    (month) => month.status !== 'hydrating',
  );
  const restorableArchiveMonths = unloadedArchiveMonths.filter(
    (month) => month.status !== 'hydrating',
  );
  const nextRestorableArchiveStatus = formatArchiveRetryStatus(nextRestorableArchiveMonth);
  const activeFilterCount =
    (selectedSource === 'all' ? 0 : 1) +
    selectedTags.length +
    (hasPhotos ? 1 : 0) +
    (fromDate ? 1 : 0) +
    (toDate ? 1 : 0);
  const hasSearchIntent = Boolean(query.trim() || activeFilterCount > 0);

  useEffect(() => {
    if (initialQuery !== undefined) setQuery(initialQuery);
  }, [initialQuery]);

  useLayoutEffect(() => {
    searchFieldAnimation.set({ opacity: 1, x: 0, y: 0, scaleX: 1, scaleY: 1 });
    if (layout !== 'desktop' || prefersReducedMotion) return;

    const compactSearch = document.querySelector<HTMLInputElement>('[data-testid="nav-search"]');
    const expandedSearch = searchFieldRef.current;
    if (!compactSearch || !expandedSearch) return;

    const compactRect = compactSearch.getBoundingClientRect();
    const expandedRect = expandedSearch.getBoundingClientRect();
    if (!compactRect.width || !compactRect.height || !expandedRect.width || !expandedRect.height)
      return;

    searchFieldAnimation.set({
      opacity: 0.82,
      x: compactRect.left - expandedRect.left,
      y: compactRect.top - expandedRect.top,
      scaleX: compactRect.width / expandedRect.width,
      scaleY: compactRect.height / expandedRect.height,
      transformOrigin: 'left top',
    });

    const animationFrame = window.requestAnimationFrame(() => {
      void searchFieldAnimation.start({
        opacity: 1,
        x: 0,
        y: 0,
        scaleX: 1,
        scaleY: 1,
        transition: motionTransitions.sharedObject,
      });
    });

    return () => {
      window.cancelAnimationFrame(animationFrame);
      searchFieldAnimation.stop();
    };
  }, [layout, prefersReducedMotion, searchFieldAnimation]);

  useEffect(() => {
    let cancelled = false;
    const loadDiaryNames = async () => {
      const summaries = await diaryRepository.listDiarySummaries();
      if (!cancelled)
        setDiaryNamesById(Object.fromEntries(summaries.map((diary) => [diary.id, diary.name])));
    };
    void loadDiaryNames();
    const unsubscribe = diaryRepository.subscribeChanges((_revision, change) => {
      if (!change || change.type.startsWith('diary-') || change.type === 'remote-batch-applied')
        void loadDiaryNames();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setIsSearching(true);
    const timer = window.setTimeout(() => {
      void (async () => {
        const filters = {
          query: query.trim() || undefined,
          tags: selectedTags,
          fromDate: fromDate || undefined,
          toDate: toDate || undefined,
          hasPhotos: hasPhotos ? true : undefined,
          excludeDiaryIds: excludeDiaryKey ? excludeDiaryKey.split('|') : [],
          limit: 100,
        };
        const nextResults: SearchResultItem[] = [];
        if (selectedSource === 'all' || selectedSource === 'diaries') {
          const entryPage = await diaryRepository.searchEntries(filters);
          entryPage.items.forEach((entry) =>
            nextResults.push({
              type: 'entry',
              id: entry.id,
              title: entry.title,
              body: richTextHtmlToPlainText(entry.body),
              date: entry.date,
              tags: entry.tags,
              diaryName: diaryNamesById[entry.diaryId] || 'Unknown Journal',
              photoCount: entry.photoCount,
              rawObj: entry,
            }),
          );
        }
        if (!hasPhotos && (selectedSource === 'all' || selectedSource === 'notes')) {
          const notePage = await diaryRepository.searchNotes(filters);
          notePage.items.forEach((note) =>
            nextResults.push({
              type: 'note',
              id: note.id,
              title: note.title,
              body: richTextHtmlToPlainText(note.body),
              date: new Date(note.updatedAt).toISOString().split('T')[0],
              tags: note.tags,
              rawObj: note,
            }),
          );
        }
        nextResults.sort((a, b) => b.date.localeCompare(a.date));
        if (!cancelled) {
          setResults(nextResults);
          setIsSearching(false);
        }
      })().catch(() => {
        if (!cancelled) setIsSearching(false);
      });
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    query,
    selectedSource,
    selectedTags,
    hasPhotos,
    fromDate,
    toDate,
    excludeDiaryKey,
    diaryNamesById,
  ]);

  const handleTagToggle = (tag: string) =>
    setSelectedTags((previous) =>
      previous.includes(tag) ? previous.filter((item) => item !== tag) : [...previous, tag],
    );
  const clearAllFilters = () => {
    setSelectedSource('all');
    setSelectedTags([]);
    setHasPhotos(false);
    setFromDate('');
    setToDate('');
    setQuery('');
  };
  const rememberSearch = () => {
    const committed = query.trim();
    if (committed)
      setRecentSearches((previous) =>
        [committed, ...previous.filter((value) => value !== committed)].slice(0, 5),
      );
  };
  const handleResultClick = (item: SearchResultItem) => {
    rememberSearch();
    if (item.type === 'entry') onNavigate('diaries', 'diaryDetail', item.rawObj.diaryId, item.id);
    else onEditNote(item.rawObj);
  };
  const selectedResult = results.find((item) => item.id === selectedResultId) || results[0] || null;
  const searchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    rememberSearch();
    if (layout === 'desktop' && selectedResult) handleResultClick(selectedResult);
  };

  const restoreOne = async () => {
    if (!nextRestorableArchiveMonth || !onHydrateArchiveMonth) return;
    setRestoringArchiveKey(String(nextRestorableArchiveMonth.partitionKey));
    setArchiveRestoreError('');
    try {
      await onHydrateArchiveMonth(String(nextRestorableArchiveMonth.partitionKey));
    } catch (error: any) {
      setArchiveRestoreError(error?.message || 'Could not restore this archive month.');
    } finally {
      setRestoringArchiveKey('');
    }
  };
  const restoreAll = async () => {
    if (!onHydrateAllArchiveMonths) return;
    setRestoringAllArchives(true);
    setArchiveRestoreError('');
    try {
      await onHydrateAllArchiveMonths();
    } catch (error: any) {
      setArchiveRestoreError(error?.message || 'Could not restore all archive months.');
    } finally {
      setRestoringAllArchives(false);
    }
  };

  const filterControls = (
    <div className="space-y-6">
      <fieldset>
        <legend className="text-sm font-bold text-brand-plum dark:text-brand-text">Source</legend>
        <div className="mt-3 grid grid-cols-3 gap-2">
          {(['all', 'diaries', 'notes'] as const).map((source) => (
            <button
              key={source}
              type="button"
              aria-pressed={selectedSource === source}
              onClick={() => setSelectedSource(source)}
              className={`min-h-11 rounded-full border px-3 text-sm font-bold capitalize ${selectedSource === source ? 'border-brand-sage bg-brand-sage text-white' : 'border-brand-border text-brand-text-muted'}`}
            >
              {source === 'diaries' ? 'Entries' : source}
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend className="text-sm font-bold text-brand-plum dark:text-brand-text">Tags</legend>
        <div className="mt-3 flex max-h-40 flex-wrap gap-2 overflow-y-auto">
          {availableTags.map((tag) => (
            <button
              key={tag}
              type="button"
              aria-pressed={selectedTags.includes(tag)}
              onClick={() => handleTagToggle(tag)}
              className={`rounded-full px-3 py-1.5 text-sm font-bold ${selectedTags.includes(tag) ? 'bg-brand-pink text-white' : 'bg-brand-sage-light text-brand-sage-dark'}`}
            >
              #{tag}
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend className="text-sm font-bold text-brand-plum dark:text-brand-text">
          Date range
        </legend>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <label className="text-xs font-bold text-brand-text-muted">
            From
            <input
              aria-label="From date"
              type="date"
              value={fromDate}
              onChange={(event) => setFromDate(event.target.value)}
              className="mt-1 min-h-11 w-full rounded-xl border border-brand-border bg-brand-bg px-3 text-sm"
            />
          </label>
          <label className="text-xs font-bold text-brand-text-muted">
            To
            <input
              aria-label="To date"
              type="date"
              value={toDate}
              onChange={(event) => setToDate(event.target.value)}
              className="mt-1 min-h-11 w-full rounded-xl border border-brand-border bg-brand-bg px-3 text-sm"
            />
          </label>
        </div>
      </fieldset>
      <label className="flex min-h-12 items-center justify-between border-y border-brand-border/60 text-sm font-bold">
        <span className="flex items-center gap-2">
          <Image className="h-4 w-4 text-brand-sage" />
          Only entries with photos
        </span>
        <input
          type="checkbox"
          checked={hasPhotos}
          onChange={(event) => setHasPhotos(event.target.checked)}
          className="h-5 w-5 accent-brand-sage"
        />
      </label>
      <AppButton tone="quiet" onClick={clearAllFilters} disabled={!hasSearchIntent}>
        Clear all filters
      </AppButton>
    </div>
  );

  const archiveNotice =
    unloadedArchiveMonths.length > 0 ? (
      <StatusNotice tone={failedArchiveMonths.length ? 'warning' : 'info'}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p>
              Some older memories are not downloaded. {unloadedArchiveMonths.length} archive month
              {unloadedArchiveMonths.length === 1 ? '' : 's'} can be included.
            </p>
            {nextRestorableArchiveStatus && (
              <p className="mt-1 text-xs">{nextRestorableArchiveStatus}</p>
            )}
            {archiveRestoreError && (
              <p role="alert" className="mt-1 text-xs font-bold text-brand-rose">
                {archiveRestoreError}
              </p>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            {onHydrateArchiveMonth && nextRestorableArchiveMonth && (
              <AppButton
                onClick={() => void restoreOne()}
                disabled={restoringAllArchives || Boolean(restoringArchiveKey)}
              >
                {restoringArchiveKey ? (
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )}
                {restoringArchiveKey ? 'Restoring' : 'Restore next'}
              </AppButton>
            )}
            {onHydrateAllArchiveMonths && restorableArchiveMonths.length > 1 && (
              <AppButton
                onClick={() => void restoreAll()}
                disabled={restoringAllArchives || Boolean(restoringArchiveKey)}
              >
                {restoringAllArchives ? 'Including…' : 'Include all'}
              </AppButton>
            )}
            {onOpenSettingsSection && (
              <AppButton tone="quiet" onClick={() => onOpenSettingsSection('data-storage')}>
                Manage storage
              </AppButton>
            )}
          </div>
        </div>
      </StatusNotice>
    ) : null;

  const discovery = (
    <div className="space-y-8 py-4">
      {recentSearches.length > 0 && (
        <section>
          <h2 className="font-serif-diary text-2xl font-semibold">Recent searches</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {recentSearches.map((value) => (
              <button
                type="button"
                key={value}
                onClick={() => setQuery(value)}
                className="rounded-full border border-brand-border px-4 py-2 text-sm font-bold"
              >
                {value}
              </button>
            ))}
          </div>
        </section>
      )}
      <section>
        <h2 className="font-serif-diary text-2xl font-semibold">Find a thread</h2>
        <p className="mt-1 text-sm text-brand-text-muted">
          Start with a journal entry, a quick note, or a familiar theme.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => {
              setSelectedSource('diaries');
              setShowFilters(false);
            }}
            className="surface-paper flex min-h-24 items-center gap-4 rounded-[var(--radius-card)] border border-brand-border/60 p-4 text-left"
          >
            <BookOpen className="h-6 w-6 text-brand-sage" />
            <span>
              <span className="block font-bold">Journal entries</span>
              <span className="text-xs text-brand-text-muted">Long-form pages and moments</span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => {
              setSelectedSource('notes');
              setShowFilters(false);
            }}
            className="surface-paper flex min-h-24 items-center gap-4 rounded-[var(--radius-card)] border border-brand-border/60 p-4 text-left"
          >
            <FileText className="h-6 w-6 text-brand-pink" />
            <span>
              <span className="block font-bold">Quick notes</span>
              <span className="text-xs text-brand-text-muted">Lightweight thoughts</span>
            </span>
          </button>
        </div>
      </section>
      {availableTags.length > 0 && (
        <section>
          <h2 className="font-serif-diary text-2xl font-semibold">Suggested themes</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {availableTags.slice(0, 8).map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => handleTagToggle(tag)}
                className="rounded-full bg-brand-sage-light px-3 py-2 text-sm font-bold text-brand-sage-dark"
              >
                #{tag}
              </button>
            ))}
          </div>
        </section>
      )}
      {!recentSearches.length && (
        <p className="max-w-xl border-l-2 border-brand-pink/30 pl-4 font-serif-diary text-lg italic text-brand-text-muted">
          Search by a phrase you remember, a feeling you named, or a theme you want to revisit.
        </p>
      )}
    </div>
  );

  const resultList = isSearching ? (
    <LoadingSkeleton lines={6} className="py-8" label="Searching memories" />
  ) : results.length === 0 ? (
    <EmptyState
      icon={<Search className="h-5 w-5" />}
      title="No results found"
      description="Try another phrase or remove a filter."
      action={
        <AppButton tone="quiet" onClick={clearAllFilters}>
          Clear filters
        </AppButton>
      }
    />
  ) : (
    <section
      aria-label="Search results"
      className="divide-y divide-brand-border/60 border-y border-brand-border/60"
    >
      {results.map((item) => (
        <button
          key={`${item.type}-${item.id}`}
          type="button"
          onClick={() =>
            layout === 'desktop' && window.matchMedia('(min-width: 1536px)').matches
              ? setSelectedResultId(item.id)
              : handleResultClick(item)
          }
          className={`block w-full px-1 py-5 text-left transition-colors hover:bg-brand-card-bg/40 ${selectedResult?.id === item.id && layout === 'desktop' ? 'border-l-2 border-brand-sage pl-4' : ''}`}
        >
          <span className="flex items-center justify-between gap-3 text-xs text-brand-text-muted">
            <span className="flex items-center gap-1.5 font-bold">
              {item.type === 'entry' ? (
                <BookOpen className="h-3.5 w-3.5" />
              ) : (
                <FileText className="h-3.5 w-3.5" />
              )}
              {item.type === 'entry' ? item.diaryName : 'Quick note'}
            </span>
            <span>{item.date}</span>
          </span>
          <h2 className="mt-2 font-serif-diary text-2xl font-semibold text-brand-plum dark:text-brand-text">
            {highlightMatch(item.title, query)}
          </h2>
          <p className="mt-2 line-clamp-3 text-sm leading-relaxed text-brand-text-muted">
            {highlightMatch(item.body, query)}
          </p>
          {item.tags.length > 0 && (
            <span className="mt-3 block text-xs font-semibold text-brand-sage">
              {item.tags
                .slice(0, 4)
                .map((tag) => `#${tag}`)
                .join('  ')}
            </span>
          )}
        </button>
      ))}
    </section>
  );

  return (
    <div className="pb-20">
      <header className="surface-glass-strong sticky top-0 z-30 -mx-2 border-b border-brand-border/60 px-2 py-3">
        <div className="flex items-end justify-between gap-4">
          {layout !== 'mobile' && (
            <div>
              <h1 className="font-serif-diary text-4xl font-semibold">Search</h1>
              <p className="mt-1 text-sm text-brand-text-muted">Find a memory, not a record.</p>
            </div>
          )}
          <button
            type="button"
            onClick={() => setShowFilters(true)}
            className="ml-auto inline-flex min-h-11 items-center gap-2 rounded-full border border-brand-border px-4 text-sm font-bold text-brand-sage"
          >
            <Filter className="h-4 w-4" />
            Filters
            {activeFilterCount > 0 && (
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-brand-pink px-1 text-xs text-white">
                {activeFilterCount}
              </span>
            )}
          </button>
        </div>
        <motion.div
          ref={searchFieldRef}
          animate={searchFieldAnimation}
          className="mt-3 will-change-transform"
        >
          <SearchField
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={searchKeyDown}
            onClear={() => setQuery('')}
            placeholder="Search thoughts, memories, dreams…"
            label="Search memories"
            className="text-base"
          />
        </motion.div>
      </header>

      {activeFilterCount > 0 && (
        <div className="no-scrollbar mt-4 flex gap-2 overflow-x-auto pb-1">
          {selectedSource !== 'all' && (
            <button
              type="button"
              onClick={() => setSelectedSource('all')}
              className="rounded-full bg-brand-sage-light px-3 py-1.5 text-xs font-bold text-brand-sage-dark"
            >
              {selectedSource === 'diaries' ? 'Entries' : 'Notes'} ×
            </button>
          )}
          {selectedTags.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => handleTagToggle(tag)}
              className="rounded-full bg-brand-sage-light px-3 py-1.5 text-xs font-bold text-brand-sage-dark"
            >
              #{tag} ×
            </button>
          ))}
          {hasPhotos && (
            <button
              type="button"
              onClick={() => setHasPhotos(false)}
              className="rounded-full bg-brand-sage-light px-3 py-1.5 text-xs font-bold text-brand-sage-dark"
            >
              Photos ×
            </button>
          )}
          {(fromDate || toDate) && (
            <button
              type="button"
              onClick={() => {
                setFromDate('');
                setToDate('');
              }}
              className="rounded-full bg-brand-sage-light px-3 py-1.5 text-xs font-bold text-brand-sage-dark"
            >
              Date range ×
            </button>
          )}
        </div>
      )}

      <div
        className={`mt-6 grid gap-7 ${layout === 'desktop' ? 'xl:grid-cols-[230px_minmax(0,1fr)] 2xl:grid-cols-[230px_minmax(0,1fr)_300px]' : ''}`}
      >
        {layout === 'desktop' && (
          <aside className="hidden border-r border-brand-border/60 pr-6 xl:block">
            {filterControls}
          </aside>
        )}
        <main className="min-w-0 space-y-5">
          {archiveNotice}
          {hasSearchIntent ? (
            <>
              <p role="status" className="text-sm text-brand-text-muted">
                {isSearching
                  ? 'Searching…'
                  : `${results.length} ${results.length === 1 ? 'memory' : 'memories'} found`}
              </p>
              {resultList}
            </>
          ) : (
            discovery
          )}
        </main>
        {layout === 'desktop' && (
          <aside className="hidden border-l border-brand-border/60 pl-6 2xl:block">
            {hasSearchIntent && selectedResult ? (
              <div className="sticky top-28">
                <p className="app-eyebrow">Preview</p>
                <h2 className="mt-3 font-serif-diary text-3xl font-semibold">
                  {selectedResult.title}
                </h2>
                <p className="mt-2 text-xs font-bold text-brand-text-muted">
                  {selectedResult.date}
                </p>
                <p className="mt-6 whitespace-pre-line text-sm leading-relaxed text-brand-text-muted">
                  {selectedResult.body}
                </p>
                <AppButton
                  tone="primary"
                  className="mt-6 w-full"
                  onClick={() => handleResultClick(selectedResult)}
                >
                  Open {selectedResult.type === 'entry' ? 'entry' : 'note'}
                  <ArrowRight className="h-4 w-4" />
                </AppButton>
              </div>
            ) : (
              <EmptyState
                icon={<Search className="h-5 w-5" />}
                title="Memory preview"
                description="Select a result to read a little more before opening it."
              />
            )}
          </aside>
        )}
      </div>

      <BottomSheet
        open={showFilters && layout !== 'desktop'}
        title="Refine memories"
        description="Narrow the search without losing your place."
        onClose={() => setShowFilters(false)}
        footer={
          <>
            <AppButton tone="quiet" onClick={clearAllFilters}>
              Clear all
            </AppButton>
            <AppButton tone="primary" onClick={() => setShowFilters(false)}>
              Show results
            </AppButton>
          </>
        }
      >
        {filterControls}
      </BottomSheet>
    </div>
  );
}
