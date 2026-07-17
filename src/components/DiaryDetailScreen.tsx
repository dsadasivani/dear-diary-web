import React, { useState, useRef, useMemo, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  ArrowLeft, Edit, Download, Settings, ChevronLeft, ChevronRight, 
  Plus, Calendar, X, Maximize2,
  Search, List, Clock, HelpCircle,
  MoreVertical, RefreshCw
} from 'lucide-react';
import { Diary, Entry, PartitionHydrationState, ResponsiveLayout } from '../types';
import AudioWaveformPlayer from './AudioWaveformPlayer';
import { diaryRepository } from '../repositories';
import OverlayPortal from './OverlayPortal';
import SyncedImage from './SyncedImage';
import SanitizedRichText from './SanitizedRichText';
import { resolveEntryIndexForEntryId } from './diaryDetailNavigation';
import { richTextHtmlToPlainText } from '../domain/richTextSanitizer';
import { useScreenPerformance } from '../hooks/useScreenPerformance';

interface DiaryDetailScreenProps {
  diary: Diary;
  entryId?: string;
  layout?: ResponsiveLayout;
  onBack: () => void;
  onEditEntry: (entryId: string) => void;
  onNewEntry: (diaryId: string, dateStr?: string) => void;
  onOpenSettings: (diaryId: string) => void;
  onRefreshEntries?: () => void | Promise<void>;
  archiveMonths?: PartitionHydrationState[];
  onHydrateArchiveMonth?: (partitionKey: string) => void | Promise<void>;
}

const sortDiaryEntries = (entries: Entry[]) =>
  [...entries].sort((a, b) => `${b.date} ${b.time || ''}`.localeCompare(`${a.date} ${a.time || ''}`));

const mergeDiaryEntries = (entries: Entry[]) => {
  const byId = new Map<string, Entry>();
  entries.forEach(entry => byId.set(entry.id, entry));
  return sortDiaryEntries([...byId.values()]);
};

const formatArchiveRetryStatus = (archiveState?: PartitionHydrationState): string => {
  if (!archiveState || archiveState.status !== 'failed') return '';
  if (archiveState.nextRetryAt && archiveState.nextRetryAt > Date.now()) {
    return `Background restore will retry after ${new Date(archiveState.nextRetryAt).toLocaleString()}. You can retry manually now.`;
  }
  return 'The previous restore attempt failed. You can retry manually now.';
};

export default function DiaryDetailScreen({
  diary,
  entryId,
  layout = 'mobile',
  onBack,
  onEditEntry,
  onNewEntry,
  onOpenSettings,
  onRefreshEntries,
  archiveMonths = [],
  onHydrateArchiveMonth,
}: DiaryDetailScreenProps) {
  useScreenPerformance('diaryDetail');
  const [diaryEntries, setDiaryEntries] = useState<Entry[]>([]);
  const [calendarEntryDates, setCalendarEntryDates] = useState<Set<string>>(() => new Set());

  // Traversal & Search State
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [showTOC, setShowTOC] = useState<boolean>(false);
  const [currentIndex, setCurrentIndex] = useState<number>(0);
  const [lightboxImg, setLightboxImg] = useState<string | null>(null);
  const [slideDirection, setSlideDirection] = useState<'left' | 'right'>('right');
  const [showMoreMenu, setShowMoreMenu] = useState<boolean>(false);

  // Calendar States
  const [showCalendar, setShowCalendar] = useState<boolean>(false);
  const [calendarYear, setCalendarYear] = useState<number>(() => {
    const today = new Date();
    return today.getFullYear();
  });
  const [calendarMonth, setCalendarMonth] = useState<number>(() => {
    const today = new Date();
    return today.getMonth(); // 0-11
  });
  const [hydratingArchiveKey, setHydratingArchiveKey] = useState<string | null>(null);
  const [archiveHydrationError, setArchiveHydrationError] = useState<string>('');

  const loadDiaryEntries = useCallback(async () => {
    const page = await diaryRepository.listEntriesByDiary(diary.id, {
      includeBody: true,
      limit: 200,
      sort: 'date-desc',
    });
    let nextEntries = page.items as Entry[];
    if (entryId && !nextEntries.some(entry => entry.id === entryId)) {
      const deepLinkedEntry = await diaryRepository.getEntry(entryId);
      if (deepLinkedEntry?.diaryId === diary.id) {
        nextEntries = [deepLinkedEntry, ...nextEntries];
      }
    }
    setDiaryEntries(mergeDiaryEntries(nextEntries));
  }, [diary.id, entryId]);

  const visibleYearMonth = `${calendarYear}-${String(calendarMonth + 1).padStart(2, '0')}`;

  const loadVisibleCalendarMonth = useCallback(async () => {
    const page = await diaryRepository.listEntriesByMonth(diary.id, visibleYearMonth, {
      includeBody: false,
      limit: 80,
      sort: 'date-asc',
    });
    setCalendarEntryDates(new Set(page.items.map(entry => entry.date)));
  }, [diary.id, visibleYearMonth]);

  React.useEffect(() => {
    void loadDiaryEntries();
    return diaryRepository.subscribeChanges((_revision, change) => {
      if (
        !change ||
        change.type === 'remote-batch-applied' ||
        (change.type.startsWith('entry-') && ('diaryId' in change ? change.diaryId === diary.id : true))
      ) {
        void loadDiaryEntries();
      }
    });
  }, [diary.id, loadDiaryEntries]);

  React.useEffect(() => {
    void loadVisibleCalendarMonth();
    return diaryRepository.subscribeChanges((_revision, change) => {
      if (
        !change ||
        change.type === 'remote-batch-applied' ||
        (change.type.startsWith('entry-') && ('diaryId' in change ? change.diaryId === diary.id : true))
      ) {
        void loadVisibleCalendarMonth();
      }
    });
  }, [diary.id, loadVisibleCalendarMonth]);

  // Swipe Gestures refs
  const touchStartX = useRef<number | null>(null);
  const touchEndX = useRef<number | null>(null);

  // Filter entries based on search query
  const filteredEntries = useMemo(() => {
    if (!searchQuery.trim()) return diaryEntries;
    const query = searchQuery.toLowerCase();
    return diaryEntries.filter(entry => 
      entry.title.toLowerCase().includes(query) ||
      richTextHtmlToPlainText(entry.body).toLowerCase().includes(query) ||
      entry.tags.some(tag => tag.toLowerCase().includes(query)) ||
      entry.moodName.toLowerCase().includes(query)
    );
  }, [diaryEntries, searchQuery]);

  // Find the active entry based on the chosen entry ID or index safely
  const activeEntry = useMemo(() => {
    if (filteredEntries.length === 0) return null;
    const currentRawEntry = diaryEntries[currentIndex];
    if (currentRawEntry && filteredEntries.some(e => e.id === currentRawEntry.id)) {
      return currentRawEntry;
    }
    return filteredEntries[0];
  }, [filteredEntries, diaryEntries, currentIndex]);

  const activeEntryIndex = useMemo(() => {
    if (!activeEntry || filteredEntries.length === 0) return -1;
    return filteredEntries.findIndex(e => e.id === activeEntry.id);
  }, [filteredEntries, activeEntry]);

  React.useEffect(() => {
    if (!entryId) return;
    setCurrentIndex(resolveEntryIndexForEntryId(diaryEntries, entryId));
  }, [entryId, diaryEntries]);

  const handlePrev = () => {
    if (activeEntryIndex < filteredEntries.length - 1) {
      setSlideDirection('left');
      const nextEntry = filteredEntries[activeEntryIndex + 1];
      const realIndex = diaryEntries.findIndex(e => e.id === nextEntry.id);
      setCurrentIndex(realIndex);
    }
  };

  const handleNext = () => {
    if (activeEntryIndex > 0) {
      setSlideDirection('right');
      const prevEntry = filteredEntries[activeEntryIndex - 1];
      const realIndex = diaryEntries.findIndex(e => e.id === prevEntry.id);
      setCurrentIndex(realIndex);
    }
  };

  // Touch handlers for page swipe gestures (Point 4)
  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.targetTouches[0].clientX;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    touchEndX.current = e.targetTouches[0].clientX;
  };

  const handleTouchEnd = () => {
    if (touchStartX.current === null || touchEndX.current === null) return;
    const diffX = touchStartX.current - touchEndX.current;
    const swipeThreshold = 55; // pixels
    if (diffX > swipeThreshold) {
      // Swiped left -> show older pages (going forwards in indices)
      handlePrev();
    } else if (diffX < -swipeThreshold) {
      // Swiped right -> show newer pages (going backwards in indices)
      handleNext();
    }
    touchStartX.current = null;
    touchEndX.current = null;
  };

  // Convert "HH:MM" to "HH:MM AM/PM" (Point 5)
  const formatTime12 = (time24?: string) => {
    if (!time24) return '';
    const [hourStr, minStr] = time24.split(':');
    const hour = parseInt(hourStr, 10);
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const hour12 = hour % 12 || 12;
    return `${String(hour12).padStart(2, '0')}:${minStr} ${ampm}`;
  };

  // Aggregate all audio URIs for the active entry (main + blocks)
  const allAudioUris = useMemo(() => {
    if (!activeEntry) return [];
    const uris: { uri: string; title: string }[] = [];
    const seenUris = new Set<string>();

    if (activeEntry.audioUri) {
      uris.push({ uri: activeEntry.audioUri, title: "Primary Reflection" });
      seenUris.add(activeEntry.audioUri);
    }
    
    if (activeEntry.blocks) {
      activeEntry.blocks.forEach((block, idx) => {
        if (block.audioUri && !seenUris.has(block.audioUri)) {
          uris.push({ 
            uri: block.audioUri, 
            title: block.time ? `Moment from ${formatTime12(block.time)}` : `Moment ${idx + 1}`
          });
          seenUris.add(block.audioUri);
        }
      });
    }
    return uris;
  }, [activeEntry]);

  const MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June", 
    "July", "August", "September", "October", "November", "December"
  ];

  const partitionKeyForDate = (dateStr: string) => `month:${dateStr.slice(0, 7)}`;
  const visibleCalendarPartitionKey = `month:${calendarYear}-${String(calendarMonth + 1).padStart(2, '0')}`;
  const visibleArchiveState = archiveMonths.find(month => month.partitionKey === visibleCalendarPartitionKey);
  const visibleArchiveNeedsHydration = Boolean(
    visibleArchiveState
    && visibleArchiveState.status !== 'hydrated'
    && visibleArchiveState.status !== 'not_available'
  );
  const visibleArchiveRetryStatus = formatArchiveRetryStatus(visibleArchiveState);

  // Calculate days for the calendar grid
  const calendarDays = useMemo(() => {
    const firstDayOfMonth = new Date(calendarYear, calendarMonth, 1);
    const startDayOfWeek = firstDayOfMonth.getDay(); // 0 = Sunday, 1 = Monday, etc.
    const daysInMonth = new Date(calendarYear, calendarMonth + 1, 0).getDate();
    
    const days = [];
    
    // Previous month's padding days
    const prevMonthYear = calendarMonth === 0 ? calendarYear - 1 : calendarYear;
    const prevMonth = calendarMonth === 0 ? 11 : calendarMonth - 1;
    const daysInPrevMonth = new Date(prevMonthYear, prevMonth + 1, 0).getDate();
    for (let i = startDayOfWeek - 1; i >= 0; i--) {
      const dayNum = daysInPrevMonth - i;
      const dateStr = `${prevMonthYear}-${String(prevMonth + 1).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
      days.push({ day: dayNum, dateStr, isCurrentMonth: false });
    }
    
    // Current month days
    for (let i = 1; i <= daysInMonth; i++) {
      const dateStr = `${calendarYear}-${String(calendarMonth + 1).padStart(2, '0')}-${String(i).padStart(2, '0')}`;
      days.push({ day: i, dateStr, isCurrentMonth: true });
    }
    
    // Next month's padding days to complete grid
    const totalCells = Math.ceil(days.length / 7) * 7;
    const nextMonthYear = calendarMonth === 11 ? calendarYear + 1 : calendarYear;
    const nextMonth = calendarMonth === 11 ? 0 : calendarMonth + 1;
    const nextPaddingCount = totalCells - days.length;
    for (let i = 1; i <= nextPaddingCount; i++) {
      const dateStr = `${nextMonthYear}-${String(nextMonth + 1).padStart(2, '0')}-${String(i).padStart(2, '0')}`;
      days.push({ day: i, dateStr, isCurrentMonth: false });
    }
    
    return days;
  }, [calendarYear, calendarMonth]);

  const handleCalendarDayClick = async (dateStr: string) => {
    const clickedPartitionKey = partitionKeyForDate(dateStr);
    const clickedArchiveState = archiveMonths.find(month => month.partitionKey === clickedPartitionKey);
    if (
      clickedArchiveState
      && clickedArchiveState.status !== 'hydrated'
      && clickedArchiveState.status !== 'not_available'
      && onHydrateArchiveMonth
    ) {
      setHydratingArchiveKey(clickedPartitionKey);
      setArchiveHydrationError('');
      try {
        await onHydrateArchiveMonth(clickedPartitionKey);
      } catch (error: any) {
        setArchiveHydrationError(error?.message || 'Could not restore this archive month.');
      } finally {
        setHydratingArchiveKey(null);
      }
      return;
    }

    // Check if there are entries on this date in this diary
    let entryForDate = diaryEntries.find(e => e.date === dateStr);
    let mergedEntriesForDate: Entry[] | null = null;
    if (!entryForDate && calendarEntryDates.has(dateStr)) {
      const monthEntries = await diaryRepository.listEntriesByMonth(diary.id, dateStr.slice(0, 7), {
        includeBody: true,
        limit: 80,
        sort: 'date-desc',
      });
      const loadedMonthEntries = monthEntries.items as Entry[];
      entryForDate = loadedMonthEntries.find(e => e.date === dateStr);
      if (entryForDate) {
        mergedEntriesForDate = mergeDiaryEntries([...diaryEntries, ...loadedMonthEntries]);
        setDiaryEntries(mergedEntriesForDate);
      }
    }
    if (entryForDate) {
      // Navigate to it
      const sourceEntries = mergedEntriesForDate || diaryEntries;
      const realIndex = sourceEntries.findIndex(e => e.id === entryForDate.id);
      setCurrentIndex(realIndex >= 0 ? realIndex : 0);
      setSearchQuery(''); // clear query to show it
      setShowCalendar(false);
    } else {
      // Create new entry for this date
      onNewEntry(diary.id, dateStr);
      setShowCalendar(false);
    }
  };

  // 3D paper fold and curling variants (Point 4)
  const entryTransitionVariants = {
    initial: (dir: 'left' | 'right') => ({
      rotateY: dir === 'left' ? 95 : -95,
      skewY: dir === 'left' ? -7 : 7,
      opacity: 0,
      scale: 0.94,
      transformOrigin: dir === 'left' ? 'right center' : 'left center',
    }),
    animate: {
      rotateY: 0,
      skewY: 0,
      opacity: 1,
      scale: 1,
      transition: {
        duration: 0.75,
        ease: [0.16, 1, 0.3, 1] // realistic elastic paper swing
      }
    },
    exit: (dir: 'left' | 'right') => ({
      rotateY: dir === 'left' ? -95 : 95,
      skewY: dir === 'left' ? 7 : -7,
      opacity: 0,
      scale: 0.94,
      transformOrigin: dir === 'left' ? 'left center' : 'right center',
      transition: {
        duration: 0.65,
        ease: [0.16, 1, 0.3, 1]
      }
    })
  };

  if (layout === 'desktop') {
    return (
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[270px_minmax(0,1fr)] xl:gap-7 2xl:grid-cols-[290px_minmax(0,1fr)_280px] 2xl:gap-8">
        <aside className="xl:sticky xl:top-6 flex max-h-[calc(100vh-9rem)] flex-col overflow-hidden rounded-[26px] border border-brand-border bg-white/68 shadow-[0_18px_55px_rgba(62,36,41,0.07)] dark:bg-brand-card-bg/55">
          <div className="border-b border-brand-border p-5">
            <button
              type="button"
              onClick={onBack}
              className="mb-5 inline-flex items-center gap-2 text-sm font-bold text-brand-sage transition-colors hover:text-brand-pink"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to library
            </button>
            <div className="flex items-center gap-3">
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl text-2xl shadow-inner" style={{ backgroundColor: diary.color }}>
                {diary.emoji}
              </span>
              <div className="min-w-0">
                <h1 className="truncate font-serif-diary text-2xl font-bold text-brand-plum dark:text-brand-text">{diary.name}</h1>
                <p className="text-xs font-semibold text-brand-text-muted">{diaryEntries.length} entries</p>
              </div>
            </div>
            <div className="relative mt-5">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-brand-text-muted" />
              <input
                type="text"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search entries..."
                className="w-full rounded-full border border-brand-border bg-brand-bg/65 py-2.5 pl-10 pr-4 text-sm font-semibold text-brand-plum outline-none focus:border-brand-sage dark:text-brand-text"
              />
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {filteredEntries.map((entry) => {
              const isSelected = activeEntry?.id === entry.id;
              return (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => {
                    const realIndex = diaryEntries.findIndex(candidate => candidate.id === entry.id);
                    setCurrentIndex(realIndex);
                  }}
                  className={`block w-full border-l-4 px-6 py-5 text-left transition-all ${
                    isSelected
                      ? 'border-brand-sage bg-brand-sage-light/36'
                      : 'border-transparent hover:bg-brand-blush-light/45'
                  }`}
                >
                  <p className="text-sm font-bold text-brand-sage">{new Date(entry.date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</p>
                  <h2 className="mt-2 font-serif-diary text-xl font-bold text-brand-plum dark:text-brand-text">{entry.title || 'Untitled reflection'}</h2>
                  <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-brand-text-muted">{richTextHtmlToPlainText(entry.body)}</p>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {entry.tags.slice(0, 3).map(tag => (
                      <span key={tag} className="rounded-full bg-white/70 px-2 py-0.5 text-[10px] font-bold text-brand-sage-dark">
                        #{tag}
                      </span>
                    ))}
                  </div>
                </button>
              );
            })}
          </div>

          <div className="border-t border-brand-border p-5">
            <button
              type="button"
              data-testid="diary-new-entry-button"
              onClick={() => onNewEntry(diary.id)}
              className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-brand-sage px-5 py-3 text-sm font-bold text-white shadow-sm transition-all hover:bg-brand-sage-dark"
            >
              <Plus className="h-4 w-4" />
              New Entry
            </button>
          </div>
        </aside>

        <main className="min-w-0">
          {diaryEntries.length === 0 ? (
            <section className="flex min-h-[560px] flex-col items-center justify-center rounded-2xl border border-brand-border bg-white/70 p-12 text-center shadow-sm dark:bg-brand-card-bg/70">
              <Calendar className="h-12 w-12 text-brand-sage" />
              <h2 className="mt-6 font-serif-diary text-4xl font-bold text-brand-plum dark:text-brand-text">A Clean Canvas Awaits</h2>
              <p className="mt-3 max-w-md text-sm leading-relaxed text-brand-text-muted">Every intimate story begins with a single silent word.</p>
              <button
                type="button"
                data-testid="diary-new-entry-button"
                onClick={() => onNewEntry(diary.id)}
                className="mt-7 inline-flex items-center gap-2 rounded-full bg-brand-sage px-6 py-3 text-sm font-bold text-white"
              >
                <Plus className="h-4 w-4" />
                Write the First Page
              </button>
            </section>
          ) : !activeEntry || filteredEntries.length === 0 ? (
            <section className="rounded-2xl border border-dashed border-brand-border bg-white/55 p-12 text-center">
              <Search className="mx-auto h-10 w-10 text-brand-sage" />
              <h2 className="mt-4 font-serif-diary text-3xl font-bold text-brand-plum dark:text-brand-text">No pages found</h2>
              <button type="button" onClick={() => setSearchQuery('')} className="mt-4 text-sm font-bold text-brand-pink">
                Clear search
              </button>
            </section>
          ) : (
            <article className="rounded-[30px] border border-brand-border bg-white/86 px-7 py-8 shadow-[0_20px_65px_rgba(62,36,41,0.08)] dark:bg-brand-card-bg/80 xl:px-10 xl:py-10 2xl:px-12 2xl:py-11">
              <div className="flex flex-wrap items-start justify-between gap-5 xl:gap-6">
                <div>
                  <p className="flex items-center gap-2 text-sm font-bold uppercase tracking-[0.18em] text-brand-sage">
                    {diary.isLocked && <Lock className="h-4 w-4" />}
                    {new Date(activeEntry.date).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
                    {activeEntry.time && ` - ${formatTime12(activeEntry.time)}`}
                  </p>
                  <h1 className="mt-4 font-serif-diary text-4xl font-semibold tracking-tight text-brand-plum dark:text-brand-text xl:text-5xl">
                    {activeEntry.title === 'Untitled entry' ? 'Untitled Reflection' : activeEntry.title}
                  </h1>
                </div>
                <button
                  type="button"
                  data-testid="entry-edit-button"
                  onClick={() => onEditEntry(activeEntry.id)}
                  className="inline-flex items-center gap-2 rounded-full bg-brand-pink px-5 py-3 text-sm font-bold text-white shadow-sm transition-all hover:bg-brand-pink-dark"
                >
                  <Edit className="h-4 w-4" />
                  Edit
                </button>
              </div>

              <div className="mt-10 max-w-3xl font-serif-diary text-xl leading-[1.8] text-brand-plum/95 dark:text-brand-text xl:text-2xl">
                {activeEntry.isTimelineBifurcated && activeEntry.blocks && activeEntry.blocks.length > 0 ? (
                  <div className="space-y-8">
                    {activeEntry.blocks.map(block => (
                      <section key={block.id} className="border-l-2 border-brand-sage/25 pl-6">
                        <p className="mb-3 inline-flex items-center gap-2 rounded-full bg-brand-sage-light px-3 py-1 text-xs font-bold uppercase tracking-widest text-brand-sage-dark">
                          <Clock className="h-3 w-3" />
                          {formatTime12(block.time)}
                        </p>
                        <SanitizedRichText className="rich-text-editor-content" html={block.body} fallback={block.audioUri ? '' : 'No content written yet.'} />
                        {block.audioUri && (
                          <div className="mt-4 max-w-md">
                            <AudioWaveformPlayer src={block.audioUri} title="Voice Moment" />
                          </div>
                        )}
                      </section>
                    ))}
                  </div>
                ) : (
                  <SanitizedRichText className="rich-text-editor-content" html={activeEntry.body} fallback={!allAudioUris.length ? 'No content written yet.' : ''} />
                )}
              </div>

              <footer className="mt-12 flex items-center justify-between border-t border-brand-border pt-6">
                <button
                  type="button"
                  onClick={handlePrev}
                  disabled={activeEntryIndex === filteredEntries.length - 1}
                  className="inline-flex items-center gap-2 text-sm font-bold text-brand-sage disabled:opacity-30"
                >
                  <ChevronLeft className="h-5 w-5" />
                  Older Entry
                </button>
                <span className="text-xs font-bold uppercase tracking-[0.18em] text-brand-text-muted">
                  {activeEntryIndex + 1} of {filteredEntries.length}
                </span>
                <button
                  type="button"
                  onClick={handleNext}
                  disabled={activeEntryIndex === 0}
                  className="inline-flex items-center gap-2 text-sm font-bold text-brand-sage disabled:opacity-30"
                >
                  Newer Entry
                  <ChevronRight className="h-5 w-5" />
                </button>
              </footer>
            </article>
          )}
        </main>

        <aside className="flex flex-col gap-5 overflow-visible xl:col-start-2 xl:row-start-2 2xl:sticky 2xl:top-8 2xl:col-start-auto 2xl:row-start-auto 2xl:max-h-[calc(100vh-10rem)] 2xl:overflow-y-auto">
          {activeEntry && (
            <>
              <section className="rounded-[24px] border border-brand-border bg-white/70 p-5 shadow-sm dark:bg-brand-card-bg/65">
                <h2 className="text-sm font-bold uppercase tracking-[0.18em] text-brand-plum dark:text-brand-text">Mood</h2>
                <div className="mt-4 flex items-center gap-3 rounded-2xl bg-brand-bg/70 p-4">
                  <span className="flex h-12 w-12 items-center justify-center rounded-full bg-brand-sage-light text-2xl">{activeEntry.moodEmoji}</span>
                  <div>
                    <p className="font-bold text-brand-plum dark:text-brand-text">{activeEntry.moodName}</p>
                    <p className="text-xs text-brand-text-muted">{activeEntry.wordCount} words</p>
                  </div>
                </div>
              </section>

              <section className="rounded-[24px] border border-brand-border bg-white/70 p-5 shadow-sm dark:bg-brand-card-bg/65">
                <h2 className="text-sm font-bold uppercase tracking-[0.18em] text-brand-plum dark:text-brand-text">Tags</h2>
                <div className="mt-4 flex flex-wrap gap-2">
                  {activeEntry.tags.length > 0 ? activeEntry.tags.map(tag => (
                    <span key={tag} className="rounded-full bg-brand-sage-light px-3 py-1.5 text-sm font-bold text-brand-sage-dark">
                      #{tag}
                    </span>
                  )) : (
                    <p className="text-sm text-brand-text-muted">No tags yet.</p>
                  )}
                </div>
              </section>

              {allAudioUris.length > 0 && (
                <section className="rounded-[24px] border border-brand-border bg-white/70 p-5 shadow-sm dark:bg-brand-card-bg/65">
                  <h2 className="text-sm font-bold uppercase tracking-[0.18em] text-brand-plum dark:text-brand-text">Voice Notes</h2>
                  <div className="mt-4 space-y-3">
                    {allAudioUris.map((audio, index) => (
                      <div key={`${audio.uri}-${index}`}>
                        <AudioWaveformPlayer src={audio.uri} title={audio.title} variant="minimal" />
                      </div>
                    ))}
                  </div>
                </section>
              )}

              <section className="rounded-[24px] border border-brand-border bg-white/70 p-5 shadow-sm dark:bg-brand-card-bg/65">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-bold uppercase tracking-[0.18em] text-brand-plum dark:text-brand-text">Scrapbook</h2>
                  <span className="text-xs font-bold text-brand-text-muted">{activeEntry.photoUris?.length || 0}</span>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-3">
                  {activeEntry.photoUris && activeEntry.photoUris.length > 0 ? activeEntry.photoUris.slice(0, 6).map((src, index) => (
                    <button
                      key={`${src}-${index}`}
                      type="button"
                      onClick={() => setLightboxImg(src)}
                      className="aspect-square overflow-hidden rounded-xl border border-brand-border bg-brand-bg"
                    >
                      <SyncedImage
                        src={src}
                        alt={`Memory ${index + 1}`}
                        className="h-full w-full object-cover transition-transform duration-500 hover:scale-105"
                        fallbackSrc="https://images.unsplash.com/photo-1517842645767-c639042777db?w=600"
                        label="entry photo"
                      />
                    </button>
                  )) : (
                    <p className="col-span-2 rounded-xl border border-dashed border-brand-border p-5 text-center text-sm text-brand-text-muted">No photos attached.</p>
                  )}
                </div>
              </section>
            </>
          )}
        </aside>

        <AnimatePresence>
          {lightboxImg && (
            <OverlayPortal>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setLightboxImg(null)}
                className="fixed inset-0 z-50 flex items-center justify-center bg-black/95 p-4 backdrop-blur-lg"
              >
                <button
                  type="button"
                  onClick={() => setLightboxImg(null)}
                  className="absolute right-6 top-6 rounded-full bg-white/10 p-3 text-white transition-all hover:bg-white/20"
                >
                  <X className="h-6 w-6" />
                </button>
                <motion.div
                  initial={{ scale: 0.95 }}
                  animate={{ scale: 1 }}
                  exit={{ scale: 0.95 }}
                  className="relative max-h-[85vh] max-w-3xl overflow-hidden rounded-2xl shadow-2xl"
                  onClick={(event) => event.stopPropagation()}
                >
                  <SyncedImage
                    src={lightboxImg}
                    alt="Enlarged memory"
                    className="max-h-[80vh] max-w-full rounded-2xl object-contain"
                    referrerPolicy="no-referrer"
                    fallbackSrc="https://images.unsplash.com/photo-1517842645767-c639042777db?w=1200"
                    label="entry photo"
                  />
                </motion.div>
              </motion.div>
            </OverlayPortal>
          )}
        </AnimatePresence>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 font-sans select-none relative">
      
      {/* Top Bar Navigation */}
      <header className="flex justify-between items-center bg-brand-bg/95 backdrop-blur-md sticky top-0 py-3 z-30 border-b border-brand-border/40 select-none">
        <div className="flex items-center gap-2">
          <button 
            onClick={onBack}
            aria-label="Back to journals"
            className="p-2 text-brand-plum hover:bg-brand-blush-light rounded-full transition-all active:scale-95"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <span className="text-xl">{diary.emoji}</span>
          <h1 className="font-serif-diary text-lg font-bold text-brand-plum truncate max-w-[150px]">{diary.name}</h1>
        </div>
        
        <div className="flex items-center gap-1.5 relative">
          {activeEntry && (
            <button 
              data-testid="entry-edit-button"
              onClick={() => onEditEntry(activeEntry.id)}
              className="p-2 text-brand-pink hover:bg-brand-blush-light rounded-full transition-all"
              title="Edit Page"
            >
              <Edit className="w-5 h-5" />
            </button>
          )}

          <button 
            data-testid="diary-new-entry-button"
            onClick={() => onNewEntry(diary.id)}
            className="bg-brand-pink text-white p-2.5 rounded-xl text-xs font-bold transition-transform hover:scale-105 active:scale-95 shadow-md shadow-brand-pink/15"
            title="New Page"
          >
            <Plus className="w-4 h-4" />
          </button>

          {/* More Options Button */}
          <button
            onClick={() => setShowMoreMenu(!showMoreMenu)}
            className={`p-2 text-brand-pink hover:bg-brand-blush-light rounded-full transition-all ${showMoreMenu ? 'bg-brand-blush-light' : ''}`}
            title="More Options"
          >
            <MoreVertical className="w-5 h-5" />
          </button>

          {/* More Options Dropdown */}
          {showMoreMenu && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowMoreMenu(false)} />
              <div className="absolute right-0 top-12 mt-2 w-56 rounded-2xl bg-white/95 dark:bg-brand-card-bg/95 backdrop-blur-md border border-brand-border/80 shadow-2xl z-50 p-2.5 flex flex-col gap-1">
                <button
                  onClick={() => {
                    setShowMoreMenu(false);
                    onOpenSettings(diary.id);
                  }}
                  className="flex items-center gap-2.5 px-3 py-2 text-xs font-bold text-brand-plum hover:bg-brand-blush-light dark:hover:bg-brand-blush-light/10 rounded-xl transition-all text-left w-full"
                >
                  <Settings className="w-4 h-4 text-brand-pink" />
                  <span>Journal Settings</span>
                </button>
              </div>
            </>
          )}
        </div>
      </header>

      {/* Traversal Tools: Search Bar & TOC Button & Custom Date Picker Calendar */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2 bg-white/70 dark:bg-brand-card-bg/50 border border-brand-border/60 p-3 rounded-2xl shadow-sm">
          <div className="relative flex-1">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-brand-sage" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search page titles, words, tags..."
              className="w-full bg-transparent pl-9 pr-4 py-2 text-sm text-brand-plum placeholder-brand-sage/60 focus:outline-none focus:border-brand-pink"
            />
            {searchQuery && (
              <button 
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 p-0.5 hover:bg-brand-blush-light rounded-full"
              >
                <X className="w-3.5 h-3.5 text-brand-sage" />
              </button>
            )}
          </div>
          
          {/* Calendar Picker Button */}
          <button
            onClick={() => setShowCalendar(!showCalendar)}
            className={`p-2.5 rounded-xl transition-all border ${
              showCalendar 
                ? 'bg-brand-pink/10 border-brand-pink text-brand-pink shadow-md' 
                : 'bg-white border-brand-border text-brand-sage hover:bg-brand-blush-light'
            }`}
            title="Calendar Day Picker"
          >
            <Calendar className="w-4.5 h-4.5 text-brand-pink" />
          </button>

          {diaryEntries.length > 0 && (
            <button
              onClick={() => setShowTOC(!showTOC)}
              className={`p-2.5 rounded-xl transition-all border ${
                showTOC 
                  ? 'bg-brand-pink/10 border-brand-pink text-brand-pink shadow-md' 
                  : 'bg-white border-brand-border text-brand-sage hover:bg-brand-blush-light'
              }`}
              title="Table of Contents Drawer"
            >
              <List className="w-4.5 h-4.5" />
            </button>
          )}
        </div>

        {/* Custom Date Picker / Calendar Dropdown */}
        <AnimatePresence>
          {showCalendar && (
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="bg-white/95 dark:bg-brand-card-bg/95 backdrop-blur-md border border-brand-border p-4 rounded-3xl shadow-xl flex flex-col gap-3 z-20"
            >
              {/* Calendar Header */}
              <div className="flex items-center justify-between">
                <button
                  onClick={() => {
                    if (calendarMonth === 0) {
                      setCalendarMonth(11);
                      setCalendarYear(prev => prev - 1);
                    } else {
                      setCalendarMonth(prev => prev - 1);
                    }
                  }}
                  className="p-1.5 hover:bg-brand-blush-light dark:hover:bg-brand-blush-light/10 rounded-lg text-brand-pink transition-all"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                
                <span className="font-serif-diary font-bold text-brand-plum text-sm">
                  {MONTH_NAMES[calendarMonth]} {calendarYear}
                </span>
                
                <button
                  onClick={() => {
                    if (calendarMonth === 11) {
                      setCalendarMonth(0);
                      setCalendarYear(prev => prev + 1);
                    } else {
                      setCalendarMonth(prev => prev + 1);
                    }
                  }}
                  className="p-1.5 hover:bg-brand-blush-light dark:hover:bg-brand-blush-light/10 rounded-lg text-brand-pink transition-all"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>

              {visibleArchiveNeedsHydration && (
                <div className="rounded-2xl border border-brand-pink/20 bg-brand-pink/5 p-3 text-left">
                  <div className="flex items-start gap-2">
                    <Download className="mt-0.5 h-4 w-4 shrink-0 text-brand-pink" />
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] font-extrabold uppercase tracking-[0.14em] text-brand-pink">
                        {visibleArchiveState?.status === 'failed'
                          ? 'Archive restore needs retry'
                          : 'Archive month not on this device'}
                      </p>
                      <p className="mt-1 text-[11px] font-medium leading-relaxed text-brand-text-muted">
                        {visibleArchiveState?.status === 'failed'
                          ? (visibleArchiveState.error || 'This encrypted archive month could not be restored last time.')
                          : 'This month exists in your encrypted archive. Restore it before opening or creating entries here.'}
                      </p>
                      {visibleArchiveRetryStatus && (
                        <p className="mt-1 text-[11px] font-semibold leading-relaxed text-brand-text-muted">
                          {visibleArchiveRetryStatus}
                        </p>
                      )}
                      {archiveHydrationError && (
                        <p className="mt-1 text-[11px] font-bold text-red-500">{archiveHydrationError}</p>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={hydratingArchiveKey === visibleCalendarPartitionKey}
                    onClick={async () => {
                      if (!onHydrateArchiveMonth) return;
                      setHydratingArchiveKey(visibleCalendarPartitionKey);
                      setArchiveHydrationError('');
                      try {
                        await onHydrateArchiveMonth(visibleCalendarPartitionKey);
                      } catch (error: any) {
                        setArchiveHydrationError(error?.message || 'Could not restore this archive month.');
                      } finally {
                        setHydratingArchiveKey(null);
                      }
                    }}
                    className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-brand-pink px-3 py-1.5 text-[10px] font-extrabold uppercase tracking-widest text-white shadow-sm transition-all hover:bg-brand-pink-dark disabled:cursor-wait disabled:bg-brand-pink/60"
                  >
                    {hydratingArchiveKey === visibleCalendarPartitionKey ? (
                      <RefreshCw className="h-3 w-3 animate-spin" />
                    ) : (
                      <Download className="h-3 w-3" />
                    )}
                    {hydratingArchiveKey === visibleCalendarPartitionKey
                      ? 'Restoring'
                      : visibleArchiveState?.status === 'failed' ? 'Retry restore' : 'Restore month'}
                  </button>
                </div>
              )}
              
              {/* Weekdays */}
              <div className="grid grid-cols-7 text-center text-[10px] font-bold text-brand-sage uppercase tracking-wider">
                <span>Su</span>
                <span>Mo</span>
                <span>Tu</span>
                <span>We</span>
                <span>Th</span>
                <span>Fr</span>
                <span>Sa</span>
              </div>
              
              {/* Days Grid */}
              <div className="grid grid-cols-7 gap-1.5">
                {calendarDays.map((cell, idx) => {
                  const hasEntry = calendarEntryDates.has(cell.dateStr) || diaryEntries.some(e => e.date === cell.dateStr);
                  const isActive = activeEntry && activeEntry.date === cell.dateStr;
                  
                  return (
                    <button
                      key={idx}
                      onClick={() => handleCalendarDayClick(cell.dateStr)}
                      className={`relative h-9 rounded-xl flex flex-col items-center justify-center text-xs font-bold transition-all ${
                        cell.isCurrentMonth 
                          ? isActive
                            ? 'bg-brand-pink text-white scale-105 shadow-md shadow-brand-pink/15'
                            : 'text-brand-plum hover:bg-brand-blush-light dark:hover:bg-brand-blush-light/10'
                          : 'text-brand-plum/25 hover:bg-brand-blush-light/50'
                      }`}
                    >
                      <span>{cell.day}</span>
                      {hasEntry && (
                        <span className={`absolute bottom-1 w-1.5 h-1.5 rounded-full ${isActive ? 'bg-white' : 'bg-brand-pink'}`} />
                      )}
                    </button>
                  );
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Main Content Area */}
      {diaryEntries.length === 0 ? (
        /* POETIC EMPTY STATE VIEW */
        <div className="flex flex-col items-center justify-center text-center py-20 px-6 gap-6 bg-white/90 dark:bg-brand-card-bg p-8 rounded-[36px] border border-brand-border/80 dark:border-brand-border/10 shadow-sm">
          <div className="w-18 h-18 rounded-3xl bg-brand-pink/10 flex items-center justify-center text-brand-pink">
            <Calendar className="w-8 h-8" />
          </div>
          <div className="space-y-2">
            <h3 className="font-serif-diary text-2xl font-bold text-brand-plum italic">A Clean Canvas Awaits</h3>
            <p className="text-xs text-brand-text-muted mt-1.5 max-w-xs leading-relaxed font-medium">
              Every intimate story begins with a single silent word. Spill your secrets, lock your dreams, or document your travel reflections in absolute privacy.
            </p>
          </div>
          <motion.button
            whileHover={{ scale: 1.03 }}
            whileTap={{ scale: 0.97 }}
            data-testid="diary-new-entry-button"
            onClick={() => onNewEntry(diary.id)}
            className="bg-brand-pink hover:bg-brand-pink-dark text-white px-8 py-3.5 rounded-full text-xs font-bold flex items-center gap-2 shadow-lg shadow-brand-pink/15 transition-all"
          >
            <Plus className="w-4 h-4" />
            Write the First Page
          </motion.button>
        </div>
      ) : filteredEntries.length === 0 ? (
        /* NO SEARCH RESULTS VIEW */
        <div className="flex flex-col items-center justify-center text-center py-16 px-6 gap-4 bg-white/50 border border-brand-border/50 rounded-3xl">
          <HelpCircle className="w-10 h-10 text-brand-sage animate-bounce" />
          <h3 className="font-serif-diary text-lg font-bold text-brand-plum">No pages found</h3>
          <p className="text-xs text-brand-text-muted max-w-xs">
            We couldn't find any entries matching "{searchQuery}" in this journal. Re-verify spelling or clear filters.
          </p>
          <button
            onClick={() => setSearchQuery('')}
            className="text-xs font-extrabold text-brand-pink uppercase tracking-widest hover:underline mt-2"
          >
            Clear Search Filter
          </button>
        </div>
      ) : (
        /* LOADED ENTRIES PAGE VIEW */
        <div className="flex flex-col gap-6 pb-16">
          
          {/* Header Pagination & Nav Buttons */}
          <div className="flex flex-col items-center gap-2 bg-white/80 dark:bg-brand-card-bg/85 backdrop-blur-md p-4 rounded-[32px] border border-brand-border/50 shadow-sm">
            <span className="text-[10px] font-extrabold text-brand-pink uppercase tracking-[0.2em]">
              Page {activeEntryIndex + 1} of {filteredEntries.length} {searchQuery ? '(Filtered)' : ''}
            </span>
            
            <div className="flex items-center justify-between w-full max-w-[280px]">
              <button 
                onClick={handlePrev}
                aria-label="Older Entry"
                disabled={activeEntryIndex === filteredEntries.length - 1}
                className={`p-2 rounded-xl transition-all ${
                  activeEntryIndex === filteredEntries.length - 1 
                    ? 'text-brand-plum/15 cursor-not-allowed' 
                    : 'text-brand-pink hover:bg-brand-blush-light dark:hover:bg-brand-blush-light/10'
                }`}
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
              
              <h2 className="font-serif-diary text-xl font-bold text-brand-plum text-center truncate px-2 italic">
                {activeEntry.date}
              </h2>
              
              <button 
                onClick={handleNext}
                aria-label="Newer Entry"
                disabled={activeEntryIndex === 0}
                className={`p-2 rounded-xl transition-all ${
                  activeEntryIndex === 0 
                    ? 'text-brand-plum/15 cursor-not-allowed' 
                    : 'text-brand-pink hover:bg-brand-blush-light dark:hover:bg-brand-blush-light/10'
                }`}
              >
                <ChevronRight className="w-5 h-5" />
              </button>
            </div>
            
            {/* A bounded position indicator avoids one tiny control for every entry. */}
            <div className="hidden">
              {filteredEntries.map((_, idx) => (
                <button
                  key={idx}
                  onClick={() => {
                    setSlideDirection(idx > activeEntryIndex ? 'left' : 'right');
                    const realIndex = diaryEntries.findIndex(e => e.id === filteredEntries[idx].id);
                    setCurrentIndex(realIndex);
                  }}
                  className={`h-1.5 rounded-full transition-all ${
                    idx === activeEntryIndex 
                      ? 'w-5 bg-brand-pink' 
                      : 'w-1.5 bg-brand-pink/20 hover:bg-brand-pink/40'
                  }`}
                />
              ))}
            </div>
          </div>

          {/* Full formatted Date, Mood, and Tag elements */}
          <div className="flex flex-col items-center gap-3">
            <div className="flex flex-wrap gap-2 justify-center">
              {/* Mood Badge */}
              <span className="inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-brand-blush-light dark:bg-brand-blush-light/10 text-brand-pink-dark rounded-full text-xs font-bold shadow-sm">
                <span>{activeEntry.moodEmoji}</span>
                <span>{activeEntry.moodName}</span>
              </span>

              {/* Tag Badges */}
              {activeEntry.tags && activeEntry.tags.map(tag => (
                <span 
                  key={tag}
                  className="inline-flex items-center px-3 py-1.5 bg-brand-sage-light dark:bg-brand-sage-light/30 text-brand-sage-dark dark:text-brand-sage-dark rounded-full text-xs font-bold border border-brand-sage/20 shadow-sm"
                >
                  #{tag}
                </span>
              ))}
            </div>

            {/* Timeline View Toggle (Bifurcation toggle on active journal entry level) */}
            <div className="flex items-center gap-2 mt-1 select-none">
              <span className="text-[10px] font-extrabold text-brand-sage uppercase tracking-wider">
                {activeEntry.isTimelineBifurcated ? 'Timeline view (Hourly)' : 'Standard day view'}
              </span>
              <button
                type="button"
                onClick={async () => {
                  const nextState = !activeEntry.isTimelineBifurcated;
                  const updatedEntry: Entry = {
                    ...activeEntry,
                    isTimelineBifurcated: nextState,
                    // If toggling on and blocks are empty, initialize blocks
                    blocks: nextState && (!activeEntry.blocks || activeEntry.blocks.length === 0)
                      ? [{ id: `block-${Date.now()}`, time: activeEntry.time || new Date().toTimeString().split(' ')[0].substring(0, 5), body: activeEntry.body || '' }]
                      : activeEntry.blocks
                  };
                  await diaryRepository.updateEntry(updatedEntry);
                  await loadDiaryEntries();
                  await loadVisibleCalendarMonth();
                  await onRefreshEntries?.();
                }}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${
                  activeEntry.isTimelineBifurcated ? 'bg-brand-pink' : 'bg-brand-sage-light'
                }`}
                title="Toggle between single daily text or hourly timeline blocks"
              >
                <span
                  className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                    activeEntry.isTimelineBifurcated ? 'translate-x-4.5' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>
          </div>

          {/* Page body with swipe gestures and realistic 3D folding curves */}
          <div 
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            className="relative min-h-[300px] bg-white dark:bg-brand-card-bg p-5 sm:p-7 rounded-[32px] border border-brand-border/60 dark:border-brand-border/10 shadow-xl journal-shadow overflow-hidden cursor-ew-resize" 
            style={{ perspective: '2000px' }}
          >
            {/* Elegant physical book spine crease shadow */}
            <div className="absolute inset-y-0 left-0 w-full pointer-events-none journal-crease z-10" />

            {/* Visual swipe hint (only on first entry to guide touch) */}
            {activeEntryIndex === 0 && (
              <div className="absolute right-4 top-4 text-[9px] font-extrabold text-brand-sage/40 uppercase tracking-widest pointer-events-none select-none flex items-center gap-1">
                <span>Swipe left/right to turn pages</span>
                <ChevronRight className="w-3 h-3" />
              </div>
            )}

            <AnimatePresence custom={slideDirection} mode="wait">
              <motion.article 
                key={activeEntry.id}
                custom={slideDirection}
                variants={entryTransitionVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                style={{ transformStyle: 'preserve-3d', backfaceVisibility: 'hidden' }}
                className={`relative font-serif-diary text-lg md:text-xl text-brand-plum leading-relaxed border-l-2 border-brand-pink/15 pl-5 py-1 select-text rich-text-editor ${
                  activeEntry.isTimelineBifurcated ? '' : 'first-letter:text-5xl first-letter:font-serif first-letter:text-brand-pink first-letter:float-left first-letter:mr-3 first-letter:leading-none first-letter:font-bold first-letter:mt-1'
                }`}
              >
                {/* Visual paper edge guide line inside the margin */}
                <div className="absolute left-0 top-0 bottom-0 w-[1px] bg-gradient-to-b from-brand-pink/20 via-brand-pink/5 to-transparent pointer-events-none" />

                <h3 className="text-xl md:text-2xl font-bold tracking-tight mb-3 text-brand-plum font-serif-diary">
                  {activeEntry.title === 'Untitled entry' ? '' : activeEntry.title}
                </h3>

                {activeEntry.isTimelineBifurcated && activeEntry.blocks && activeEntry.blocks.length > 0 ? (
                  <div className="flex flex-col gap-4 mt-2 select-text">
                    {activeEntry.blocks.map((block) => (
                      <div key={block.id} className="relative pl-5 border-l border-brand-pink/20 flex flex-col gap-1 text-left">
                        {/* Aesthetic Local Badge for Time */}
                        <div className="absolute -left-[4.5px] top-2.5 w-2 h-2 rounded-full bg-brand-pink" />
                        
                        <div className="flex items-center gap-1.5 select-none">
                          <span className="font-mono text-[10px] font-extrabold text-brand-pink uppercase tracking-widest bg-brand-pink/5 px-2.5 py-0.5 rounded-full border border-brand-pink/10 shadow-sm flex items-center gap-1">
                            <Clock className="w-2.5 h-2.5" />
                            {formatTime12(block.time)}
                          </span>
                        </div>
                        
                        <SanitizedRichText
                          className="rich-text-editor-content text-base md:text-lg text-brand-plum/90 font-serif-diary select-text"
                          html={block.body}
                          fallback={block.audioUri ? '' : 'No content written yet.'}
                        />

                        {block.audioUri && (
                          <div className="mt-2 w-full max-w-sm">
                            <AudioWaveformPlayer src={block.audioUri} title={`Voice Moment`} />
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    <SanitizedRichText
                      className="rich-text-editor-content text-base md:text-lg text-brand-plum/90 font-serif-diary select-text"
                      html={activeEntry.body}
                      fallback={!allAudioUris.length ? 'No content written yet.' : ''}
                    />
                    
                    {allAudioUris.length > 0 && (
                      <div className="mt-6 pt-6 border-t border-brand-border/10 flex flex-col gap-4">
                        <div className="flex items-center gap-2">
                          <span className="w-1.5 h-1.5 rounded-full bg-brand-pink" />
                          <h4 className="text-[10px] font-extrabold text-brand-pink uppercase tracking-[0.2em]">
                            Voice Sanctuary ({allAudioUris.length})
                          </h4>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                          {allAudioUris.map((audio, idx) => (
                            <div key={idx} className="w-full">
                              <AudioWaveformPlayer src={audio.uri} title={audio.title} />
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </motion.article>
            </AnimatePresence>
          </div>

          {/* Attachments Memory Photo Gallery */}
          {activeEntry.photoUris && activeEntry.photoUris.length > 0 && (
            <section className="mt-6 flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-brand-pink" />
                <h3 className="text-[10px] font-extrabold text-brand-pink uppercase tracking-[0.25em]">
                  Scrapbook Memories ({activeEntry.photoUris.length})
                </h3>
              </div>
              
              <div className="flex overflow-x-auto gap-4.5 no-scrollbar -mx-4 px-4 pb-3 select-none">
                {activeEntry.photoUris.map((imgSrc, idx) => (
                  <motion.div 
                    key={idx}
                    whileHover={{ scale: 1.02, y: -2 }}
                    className="w-44 h-56 flex-none rounded-2xl overflow-hidden shadow-md border border-brand-border/60 bg-brand-blush-light/10 relative group cursor-zoom-in"
                  >
                    <SyncedImage
                      src={imgSrc}
                      alt={`Memory ${idx + 1}`}
                      className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105"
                      referrerPolicy="no-referrer"
                      fallbackSrc="https://images.unsplash.com/photo-1517842645767-c639042777db?w=600"
                      label="entry photo"
                      onClick={setLightboxImg}
                    />
                    <div className="pointer-events-none absolute inset-0 bg-black/20 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                      <Maximize2 className="w-5 h-5 text-white drop-shadow-md" />
                    </div>
                  </motion.div>
                ))}
              </div>
            </section>
          )}

          {/* Bottom Edit Action Shortcut Button */}
          <div className="flex justify-center pt-8 select-none">
            <motion.button
              whileHover={{ scale: 1.04 }}
              whileTap={{ scale: 0.96 }}
              data-testid="entry-edit-button"
              onClick={() => onEditEntry(activeEntry.id)}
              className="bg-brand-pink text-white hover:bg-brand-pink-dark px-8 py-3.5 rounded-full text-xs font-bold transition-all shadow-md shadow-brand-pink/15 flex items-center gap-2"
            >
              <Edit className="w-4 h-4" />
              Edit this entry
            </motion.button>
          </div>
        </div>
      )}

      {/* TABLE OF CONTENTS DRAWER POPUP */}
      <AnimatePresence>
        {showTOC && (
          <OverlayPortal>
            <div className="fixed inset-0 z-50 flex justify-end bg-black/50 backdrop-blur-sm" onClick={() => setShowTOC(false)}>
            <motion.div 
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              className="w-full max-w-sm h-full bg-brand-bg dark:bg-brand-card-bg shadow-2xl p-6 overflow-y-auto flex flex-col gap-4"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex justify-between items-center border-b border-brand-border pb-3">
                <div className="flex items-center gap-2">
                  <List className="w-5 h-5 text-brand-pink" />
                  <h3 className="font-serif-diary text-lg font-bold text-brand-plum">Table of Contents</h3>
                </div>
                <button 
                  onClick={() => setShowTOC(false)}
                  className="p-1.5 hover:bg-brand-blush-light dark:hover:bg-brand-blush-light/10 rounded-full text-brand-sage"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Drawer Outline Search field */}
              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-brand-sage" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Filter table of contents..."
                  className="w-full bg-white dark:bg-brand-bg/50 border border-brand-border/60 pl-8 pr-4 py-2 rounded-xl text-xs text-brand-plum"
                />
              </div>

              {/* Table of Contents List */}
              <div className="flex flex-col gap-2.5 flex-1 overflow-y-auto pr-1">
                {filteredEntries.map((entry, idx) => {
                  const isSelected = idx === activeEntryIndex;
                  return (
                    <button
                      key={entry.id}
                      onClick={() => {
                        const realIndex = diaryEntries.findIndex(e => e.id === entry.id);
                        setCurrentIndex(realIndex);
                        setShowTOC(false);
                      }}
                      className={`w-full text-left p-3.5 rounded-2xl border transition-all flex flex-col gap-1.5 ${
                        isSelected
                          ? 'bg-brand-pink/10 border-brand-pink/40 text-brand-plum'
                          : 'bg-white dark:bg-brand-card-bg border-brand-border hover:bg-brand-blush-light/20'
                      }`}
                    >
                      <div className="flex justify-between items-center w-full">
                        <span className="text-[10px] font-extrabold text-brand-pink uppercase tracking-widest">{entry.date}</span>
                        <span className="text-xs">{entry.moodEmoji}</span>
                      </div>
                      <h4 className="font-serif-diary font-bold text-sm text-brand-plum line-clamp-1 leading-snug">
                        {entry.title || 'Untitled reflection'}
                      </h4>
                      <p className="text-[10px] text-brand-sage truncate leading-none">
                        {entry.tags.map(t => `#${t}`).join(' ') || 'No tags'} • {entry.wordCount} words
                      </p>
                    </button>
                  );
                })}
              </div>
            </motion.div>
            </div>
          </OverlayPortal>
        )}
      </AnimatePresence>

      {/* PHOTO LIGHTBOX POPUP */}
      <AnimatePresence>
        {lightboxImg && (
          <OverlayPortal>
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setLightboxImg(null)}
              className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/95 backdrop-blur-lg"
            >
            {/* Close Button */}
            <button 
              onClick={() => setLightboxImg(null)}
              className="absolute top-6 right-6 p-3 bg-white/10 hover:bg-white/20 text-white rounded-full transition-all"
            >
              <X className="w-6 h-6" />
            </button>

            <motion.div 
              initial={{ scale: 0.95 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0.95 }}
              className="max-w-3xl max-h-[85vh] rounded-2xl overflow-hidden shadow-2xl relative"
              onClick={(e) => e.stopPropagation()}
            >
              <SyncedImage
                src={lightboxImg} 
                alt="Enlarged memory" 
                className="max-w-full max-h-[80vh] object-contain rounded-2xl"
                referrerPolicy="no-referrer"
                fallbackSrc="https://images.unsplash.com/photo-1517842645767-c639042777db?w=1200"
                label="entry photo"
              />
            </motion.div>
            </motion.div>
          </OverlayPortal>
        )}
      </AnimatePresence>
    </div>
  );
}
