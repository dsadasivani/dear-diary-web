import React, { useState, useEffect } from 'react';
import {
  Flame,
  BookOpen,
  Camera,
  Settings,
  ArrowRight,
  Sparkles,
  X,
  ChevronDown,
} from 'lucide-react';
import { Diary, Entry, PartitionHydrationState, ResponsiveLayout } from '../types';
import { calculateStreak } from '../domain/journalCatalog';
import { richTextHtmlToPlainText } from '../domain/richTextSanitizer';
import SyncedImage from './SyncedImage';
import { useScreenPerformance } from '../hooks/useScreenPerformance';
import { toLocalDateKey } from '../utils/localDate';
import { diaryRepository } from '../repositories';
import type { EntrySummary, GlobalStatistics, NoteSummary } from '../repositories/DiaryRepository';
import { AppButton, StatusNotice } from './UiPrimitives';
import { EmptyState, LoadingSkeleton, ProgressIndicator } from './ui/Feedback';

interface StatsScreenProps {
  diaries: Diary[];
  excludeDiaryIds?: string[];
  archiveMonths?: PartitionHydrationState[];
  layout?: ResponsiveLayout;
  onNavigate: (
    tab: string,
    screen?: string,
    diaryId?: string,
    entryId?: string,
    dateStr?: string,
    noteId?: string,
    promptText?: string,
  ) => void;
}

export default function StatsScreen({
  diaries,
  excludeDiaryIds = [],
  archiveMonths = [],
  layout = 'mobile',
  onNavigate,
}: StatsScreenProps) {
  useScreenPerformance('stats');
  const [entries, setEntries] = useState<EntrySummary[]>([]);
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [globalStats, setGlobalStats] = useState<GlobalStatistics | null>(null);
  const [streak, setStreak] = useState<number>(0);
  const [totalPhotos, setTotalPhotos] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [selectedPixelYear, setSelectedPixelYear] = useState<number>(() =>
    new Date().getFullYear(),
  );
  const [pixelViewMode, setPixelViewMode] = useState<'year' | 'month'>('month');
  const [selectedPixelMonth, setSelectedPixelMonth] = useState<number>(() => new Date().getMonth());
  const [selectedPixelEntry, setSelectedPixelEntry] = useState<Entry | null>(null);
  const [selectedPixelDate, setSelectedPixelDate] = useState<string>('');
  const excludeDiaryKey = excludeDiaryIds.join('|');

  useEffect(() => {
    let cancelled = false;
    const loadStatsData = async () => {
      const filters = { excludeDiaryIds: excludeDiaryKey ? excludeDiaryKey.split('|') : [] };
      const loadEntries = async () => {
        const items: EntrySummary[] = [];
        let cursor: string | undefined;
        do {
          const page = await diaryRepository.searchEntries({
            ...filters,
            includeBody: false,
            limit: 500,
            cursor,
          });
          items.push(...page.items);
          cursor = page.nextCursor;
        } while (cursor);
        return items;
      };
      const loadNotes = async () => {
        const items: NoteSummary[] = [];
        let cursor: string | undefined;
        do {
          const page = await diaryRepository.listNotes({ includeBody: false, limit: 500, cursor });
          items.push(...(page.items as NoteSummary[]));
          cursor = page.nextCursor;
        } while (cursor);
        return items;
      };
      const [entryItems, noteItems, nextGlobalStats] = await Promise.all([
        loadEntries(),
        loadNotes(),
        diaryRepository.getGlobalStatistics(filters),
      ]);
      if (cancelled) return;
      setEntries(entryItems);
      setNotes(noteItems);
      setGlobalStats(nextGlobalStats);
      setLoading(false);
    };
    void loadStatsData();
    const unsubscribe = diaryRepository.subscribeChanges((_revision, change) => {
      if (
        !change ||
        change.type === 'remote-batch-applied' ||
        change.type.startsWith('entry-') ||
        change.type.startsWith('note-')
      ) {
        void loadStatsData();
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [excludeDiaryKey]);

  const selectPixelEntry = async (summary: EntrySummary, date: string): Promise<void> => {
    setSelectedPixelDate(date);
    setSelectedPixelEntry(await diaryRepository.getEntry(summary.id));
  };

  // Dynamically extract all years where entries exist, plus current year
  const availableYears = React.useMemo(() => {
    const yearsSet = new Set<number>();
    yearsSet.add(new Date().getFullYear()); // always include current year
    entries.forEach((e) => {
      if (e.date) {
        const yr = parseInt(e.date.split('-')[0], 10);
        if (!isNaN(yr)) {
          yearsSet.add(yr);
        }
      }
    });
    return Array.from(yearsSet).sort((a, b) => b - a);
  }, [entries]);

  useEffect(() => {
    // calculate real streak
    const calculated = calculateStreak(entries);
    setStreak(calculated);

    if (globalStats) {
      setTotalPhotos(globalStats.photoCount);
      return;
    }

    // count photos
    let pCount = 0;
    entries.forEach((e) => {
      if (e.photoUris) {
        pCount += e.photoUris.length;
      }
    });
    setTotalPhotos(pCount);
  }, [entries, globalStats]);

  // Point 4: Calculate real mood distribution and tag correlations
  const getMoodData = () => {
    const counts: { [key: string]: { count: number; emoji: string } } = {};

    const defaultEmojis: { [key: string]: string } = {
      Joyful: '😊',
      Calm: '😌',
      Sad: '😢',
      Anxious: '😟',
      Excited: '🤩',
      Reflective: '💭',
      Tired: '😴',
      Creative: '🎨',
    };

    entries.forEach((e) => {
      const mood = e.moodName || 'Reflective';
      const emoji = e.moodEmoji || defaultEmojis[mood] || '💭';
      if (!counts[mood]) {
        counts[mood] = { count: 0, emoji };
      }
      counts[mood].count += 1;
    });

    const total = entries.length || 1;
    return Object.entries(counts)
      .map(([name, data]) => ({
        name,
        emoji: data.emoji,
        count: data.count,
        percentage: Math.round((data.count / total) * 100),
      }))
      .sort((a, b) => b.count - a.count);
  };

  const getMoodTagCorrelations = () => {
    if (entries.length < 5) return [];
    const correlation: { [mood: string]: { [tag: string]: number } } = {};

    entries.forEach((e) => {
      const mood = e.moodName;
      if (!mood) return;
      if (!correlation[mood]) {
        correlation[mood] = {};
      }
      e.tags.forEach((t) => {
        correlation[mood][t] = (correlation[mood][t] || 0) + 1;
      });
    });

    const insights: { mood: string; tag: string; count: number }[] = [];
    Object.entries(correlation).forEach(([mood, tags]) => {
      const sortedTags = Object.entries(tags).sort((a, b) => b[1] - a[1]);
      if (sortedTags.length > 0) {
        insights.push({
          mood,
          tag: sortedTags[0][0],
          count: sortedTags[0][1],
        });
      }
    });

    return insights.slice(0, 3);
  };

  const getInsightCorrelation = () => {
    if (entries.length < 5) return [];
    const highMoods = ['Joyful', 'Calm', 'Excited', 'Creative'];
    const tagScores: { [tag: string]: number } = {};

    entries.forEach((e) => {
      const isHighMood = highMoods.some(
        (hm) => hm.toLowerCase() === (e.moodName || '').toLowerCase(),
      );
      if (isHighMood && e.tags) {
        e.tags.forEach((t) => {
          tagScores[t] = (tagScores[t] || 0) + 1;
        });
      }
    });

    return Object.entries(tagScores)
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);
  };

  // Heatmap generation: last 30 days
  const getHeatmapData = () => {
    const list = [];
    const today = new Date();

    for (let i = 29; i >= 0; i--) {
      const d = new Date();
      d.setDate(today.getDate() - i);
      const dateStr = toLocalDateKey(d);

      // Count entries on this date
      const entriesOnDate = entries.filter((e) => e.date === dateStr).length;
      const notesOnDate = notes.filter((n) => toLocalDateKey(n.updatedAt) === dateStr).length;
      const weight = entriesOnDate * 2 + notesOnDate; // formal entries weigh more

      list.push({
        date: dateStr,
        dayNum: d.getDate(),
        count: entriesOnDate + notesOnDate,
        weight: Math.min(weight, 4), // cap weight at 4 for color rendering
      });
    }
    return list;
  };

  // Tag frequency ranking
  const getTopTags = () => {
    const counts: { [key: string]: number } = {};
    entries.forEach((e) => {
      e.tags.forEach((t) => {
        counts[t] = (counts[t] || 0) + 1;
      });
    });
    notes.forEach((n) => {
      n.tags.forEach((t) => {
        counts[t] = (counts[t] || 0) + 1;
      });
    });

    const sorted = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    const maxCount = sorted.length > 0 ? sorted[0][1] : 1;

    return sorted.map(([tag, count]) => ({
      tag,
      count,
      percentage: Math.round((count / maxCount) * 100),
    }));
  };

  // Get all photo memories chronologically
  const getPhotoMemories = () => {
    const photos: { src: string; date: string; entryId: string; diaryId: string }[] = [];

    const sortedEntries = [...entries].sort((a, b) => b.date.localeCompare(a.date));

    sortedEntries.forEach((e) => {
      if (e.photoUris) {
        e.photoUris.forEach((src) => {
          photos.push({
            src,
            date: e.date,
            entryId: e.id,
            diaryId: e.diaryId,
          });
        });
      }
    });

    return photos.slice(0, 8);
  };

  const heatmap = getHeatmapData();
  const topTags = getTopTags();
  const photos = getPhotoMemories();
  const moodData = getMoodData();
  const moodCorrelations = getMoodTagCorrelations();
  const hasUnhydratedArchives = archiveMonths.some((month) => month.status !== 'hydrated');
  const entryScopeLabel = hasUnhydratedArchives ? 'Downloaded Entries' : 'Total Entries';
  const photoScopeLabel = hasUnhydratedArchives ? 'Downloaded Photos' : 'Visual Memories';
  const scopeHint =
    'Insights reflect entries available on this device. Restore older archive months to complete these totals.';

  const dominantMoodSummary = moodData[0];
  const entriesByDate = new Map<string, EntrySummary>(
    entries.map((entry) => [entry.date, entry] as [string, EntrySummary]),
  );
  const monthNames = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  const selectedMonthPrefix = `${selectedPixelYear}-${String(selectedPixelMonth + 1).padStart(2, '0')}`;
  const selectedMonthEntryCount = entries.filter((entry) =>
    entry.date.startsWith(selectedMonthPrefix),
  ).length;
  const monthlyNarrative =
    entries.length === 0
      ? 'Your reflections will gather here as you begin writing.'
      : selectedMonthEntryCount > 0
        ? `You wrote ${selectedMonthEntryCount} ${selectedMonthEntryCount === 1 ? 'reflection' : 'reflections'} in ${monthNames[selectedPixelMonth]}. ${dominantMoodSummary ? `${dominantMoodSummary.name} was the mood label you used most often across available entries.` : ''}`
        : `No reflections are available for ${monthNames[selectedPixelMonth]} yet. Your current writing streak is ${streak} ${streak === 1 ? 'day' : 'days'}.`;
  const mobileMonthlySummary =
    selectedMonthEntryCount > 0
      ? `${selectedMonthEntryCount} ${selectedMonthEntryCount === 1 ? 'reflection' : 'reflections'}${dominantMoodSummary ? ` · Mostly ${dominantMoodSummary.name.toLowerCase()}` : ''}`
      : 'No reflections';
  const insightStories = [
    streak > 0
      ? `Your current writing streak is ${streak} ${streak === 1 ? 'day' : 'days'}.`
      : 'A new writing streak can begin with one small reflection.',
    dominantMoodSummary
      ? `${dominantMoodSummary.name} appears in ${dominantMoodSummary.percentage}% of available entries.`
      : 'Mood patterns will appear after you label a few entries.',
    topTags[0]
      ? `#${topTags[0].tag} is your most frequently used theme.`
      : 'Themes will become visible as you add tags.',
  ];
  const mobileInsightStories = [
    streak > 0 ? `${streak} day streak` : 'Start a streak',
    dominantMoodSummary
      ? `${dominantMoodSummary.name} · ${dominantMoodSummary.percentage}%`
      : 'Add moods to see patterns',
    topTags[0] ? `#${topTags[0].tag} · Most used` : 'Add tags to see themes',
  ];
  const moodPixelClass = (moodName?: string) => {
    const normalized = (moodName || '').toLowerCase();
    if (normalized.includes('calm')) return 'mood-pixel-calm';
    if (normalized.includes('joy') || normalized.includes('happy')) return 'mood-pixel-joyful';
    if (normalized.includes('sad')) return 'mood-pixel-sad';
    if (normalized.includes('anxious')) return 'mood-pixel-anxious';
    if (normalized.includes('creative')) return 'mood-pixel-creative';
    return 'bg-brand-sage-light';
  };
  const choosePixelDate = (date: string) => {
    const entry = entriesByDate.get(date);
    if (entry) void selectPixelEntry(entry, date);
    else {
      setSelectedPixelEntry(null);
      setSelectedPixelDate(date);
    }
  };
  const createReflectionForDate = (date: string) => {
    const targetDiary = diaries[0];
    if (targetDiary) onNavigate('diaries', 'entryEditor', targetDiary.id, '', date);
    else onNavigate('diaries');
  };

  return (
    <div className="space-y-8 pb-24">
      <header className="surface-glass-strong sticky top-0 z-30 -mx-2 flex items-center justify-between border-b border-brand-border/60 px-2 py-3">
        {layout !== 'mobile' && (
          <div>
            <h1 className="type-page-title font-bold">Insights</h1>
            <p className="mt-1 text-sm text-brand-text-muted">
              A gentle view of your writing over time.
            </p>
          </div>
        )}
        <button
          type="button"
          aria-label="Open settings"
          onClick={() => onNavigate('stats', 'appSettings')}
          className="icon-button"
        >
          <Settings className="h-5 w-5" />
        </button>
      </header>

      {hasUnhydratedArchives && (
        <StatusNotice tone="info">
          {layout === 'mobile' ? 'Totals use downloaded entries.' : scopeHint}
        </StatusNotice>
      )}
      {loading ? (
        <LoadingSkeleton lines={7} label="Loading insights" className="py-12" />
      ) : entries.length === 0 ? (
        <EmptyState
          icon={<Sparkles className="h-5 w-5" />}
          title="Your reflection is just beginning"
          description="Write a few entries to see patterns."
          action={
            <AppButton tone="primary" onClick={() => createReflectionForDate(toLocalDateKey())}>
              Write an entry
            </AppButton>
          }
        />
      ) : (
        <>
          <section className="surface-paper rounded-[var(--radius-sheet)] border-x border-brand-border/60 px-5 py-7 md:px-8 md:py-9">
            <p className="app-eyebrow hidden sm:block">Monthly reflection</p>
            {layout === 'mobile' ? (
              <div>
                <h2 className="font-serif-diary text-3xl font-semibold leading-tight text-brand-plum dark:text-brand-text">
                  {monthNames[selectedPixelMonth]}
                </h2>
                <p className="mt-1 text-sm font-semibold text-brand-text-muted">
                  {mobileMonthlySummary}
                </p>
              </div>
            ) : (
              <h2 className="mt-3 max-w-4xl font-serif-diary text-3xl font-semibold leading-tight text-brand-plum dark:text-brand-text md:text-4xl">
                {monthlyNarrative}
              </h2>
            )}
            <div className="mt-7 grid grid-cols-3 gap-4 border-t border-brand-border/60 pt-5">
              <div>
                <Flame className="h-4 w-4 text-brand-pink" />
                <p className="mt-2 text-3xl font-bold tabular-nums">{streak}</p>
                <p className="text-xs text-brand-text-muted">
                  {layout === 'mobile' ? 'streak' : 'day streak'}
                </p>
              </div>
              <div>
                <BookOpen className="h-4 w-4 text-brand-sage" />
                <p className="mt-2 text-3xl font-bold tabular-nums">{entries.length}</p>
                <p className="text-xs text-brand-text-muted">
                  {layout === 'mobile' ? 'entries' : entryScopeLabel.toLowerCase()}
                </p>
              </div>
              <div>
                <Camera className="h-4 w-4 text-brand-pink" />
                <p className="mt-2 text-3xl font-bold tabular-nums">{totalPhotos}</p>
                <p className="text-xs text-brand-text-muted">
                  {layout === 'mobile' ? 'photos' : photoScopeLabel.toLowerCase()}
                </p>
              </div>
            </div>
          </section>

          <section aria-label="Insight stories">
            <h2 className="type-section-title font-bold">
              {layout === 'mobile' ? 'Highlights' : 'A few things you may notice'}
            </h2>
            <div
              className="no-scrollbar mt-4 flex snap-x gap-3 overflow-x-auto pb-2"
              tabIndex={0}
              aria-label="Insight stories; scroll horizontally for more"
            >
              {(layout === 'mobile' ? mobileInsightStories : insightStories).map((story, index) => (
                <article
                  key={story}
                  className={`surface-paper snap-start rounded-[var(--radius-card)] border border-brand-border/60 p-5 sm:min-w-[280px] ${layout === 'mobile' ? 'min-w-[58%]' : 'min-w-[82%]'}`}
                >
                  <p className="text-xs font-bold text-brand-pink">
                    {String(index + 1).padStart(2, '0')}
                  </p>
                  <p
                    className={`${layout === 'mobile' ? 'mt-3 text-lg' : 'mt-5 text-xl'} font-serif-diary leading-snug text-brand-plum dark:text-brand-text`}
                  >
                    {story}
                  </p>
                </article>
              ))}
            </div>
          </section>

          <div
            className={`grid gap-8 ${layout === 'desktop' ? 'xl:grid-cols-[minmax(0,1.35fr)_minmax(280px,0.65fr)]' : ''}`}
          >
            <main className="min-w-0 space-y-9">
              <section
                className="border-y border-brand-border/60 py-6"
                aria-labelledby="consistency-title"
              >
                <div className="flex items-end justify-between gap-4">
                  <div>
                    <h2 id="consistency-title" className="type-section-title font-bold">
                      Writing consistency
                    </h2>
                    <p className="mt-1 hidden text-sm text-brand-text-muted sm:block">
                      The last 30 days, with entries weighted a little more than notes.
                    </p>
                  </div>
                  <span className="text-xs font-bold text-brand-text-muted">Less → More</span>
                </div>
                <div
                  className="mt-6 grid grid-cols-10 gap-2"
                  role="img"
                  aria-label="Writing activity during the last 30 days"
                >
                  {heatmap.map((item) => (
                    <span
                      key={item.date}
                      title={`${item.date}: ${item.count} written items`}
                      className={`aspect-square rounded-[5px] border border-brand-border/40 ${item.weight === 0 ? 'bg-brand-bg' : item.weight === 1 ? 'bg-brand-blush-light' : item.weight === 2 ? 'bg-brand-pink/35' : item.weight === 3 ? 'bg-brand-pink/65' : 'bg-brand-pink'}`}
                    />
                  ))}
                </div>
              </section>

              <section aria-labelledby="pixels-title">
                <div className="flex flex-wrap items-end justify-between gap-4">
                  <div>
                    <h2 id="pixels-title" className="type-section-title font-bold">
                      {pixelViewMode === 'month' ? 'Month' : 'Year'} in Pixels
                    </h2>
                    <p className="mt-1 text-sm text-brand-text-muted">
                      A compact map of the mood labels you chose.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <label className="sr-only" htmlFor="pixel-view">
                      Pixel view
                    </label>
                    <select
                      id="pixel-view"
                      value={pixelViewMode}
                      onChange={(event) => setPixelViewMode(event.target.value as 'year' | 'month')}
                      className="min-h-11 rounded-full border border-brand-border bg-brand-card-bg px-3 text-sm font-bold"
                    >
                      <option value="month">Month view</option>
                      <option value="year">Year view</option>
                    </select>
                    <label className="sr-only" htmlFor="pixel-year">
                      Year
                    </label>
                    <select
                      id="pixel-year"
                      value={selectedPixelYear}
                      onChange={(event) => setSelectedPixelYear(Number(event.target.value))}
                      className="min-h-11 rounded-full border border-brand-border bg-brand-card-bg px-3 text-sm font-bold"
                    >
                      {availableYears.map((year) => (
                        <option key={year} value={year}>
                          {year}
                        </option>
                      ))}
                    </select>
                    {pixelViewMode === 'month' && (
                      <>
                        <label className="sr-only" htmlFor="pixel-month">
                          Month
                        </label>
                        <select
                          id="pixel-month"
                          value={selectedPixelMonth}
                          onChange={(event) => setSelectedPixelMonth(Number(event.target.value))}
                          className="min-h-11 rounded-full border border-brand-border bg-brand-card-bg px-3 text-sm font-bold"
                        >
                          {monthNames.map((name, index) => (
                            <option key={name} value={index}>
                              {name}
                            </option>
                          ))}
                        </select>
                      </>
                    )}
                  </div>
                </div>
                {pixelViewMode === 'month' ? (
                  <div className="mt-6">
                    <div className="grid grid-cols-7 gap-2 text-center text-xs font-bold text-brand-text-muted">
                      {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((day, index) => (
                        <span key={`${day}-${index}`}>{day}</span>
                      ))}
                    </div>
                    <div className="mt-2 grid grid-cols-7 gap-2">
                      {Array.from(
                        { length: new Date(selectedPixelYear, selectedPixelMonth, 1).getDay() },
                        (_, index) => (
                          <span key={`empty-${index}`} aria-hidden="true" />
                        ),
                      )}
                      {Array.from(
                        {
                          length: new Date(selectedPixelYear, selectedPixelMonth + 1, 0).getDate(),
                        },
                        (_, index) => {
                          const day = index + 1;
                          const date = `${selectedPixelYear}-${String(selectedPixelMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                          const entry = entriesByDate.get(date);
                          return (
                            <button
                              key={date}
                              type="button"
                              onClick={() => choosePixelDate(date)}
                              aria-label={
                                entry
                                  ? `${date}, ${entry.moodName}, ${entry.title}`
                                  : `${date}, no reflection`
                              }
                              className={`aspect-square min-h-11 rounded-[var(--radius-control)] border border-brand-border/40 p-1 text-xs font-bold transition-transform active:scale-95 ${entry ? moodPixelClass(entry.moodName) : 'bg-brand-bg/55 text-brand-text-muted'} ${selectedPixelDate === date ? 'ring-2 ring-brand-sage ring-offset-2' : ''}`}
                            >
                              <span>{day}</span>
                              <span className="sr-only">{entry?.moodName}</span>
                            </button>
                          );
                        },
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="no-scrollbar mt-6 overflow-x-auto">
                    <div className="grid min-w-[420px] grid-cols-12 gap-1.5">
                      {Array.from({ length: 12 }, (_, monthIndex) => (
                        <div key={monthIndex}>
                          <p className="mb-2 text-center text-xs font-bold text-brand-text-muted">
                            {monthNames[monthIndex].slice(0, 1)}
                          </p>
                          <div className="space-y-1">
                            {Array.from(
                              { length: new Date(selectedPixelYear, monthIndex + 1, 0).getDate() },
                              (_, dayIndex) => {
                                const date = `${selectedPixelYear}-${String(monthIndex + 1).padStart(2, '0')}-${String(dayIndex + 1).padStart(2, '0')}`;
                                const entry = entriesByDate.get(date);
                                return (
                                  <button
                                    key={date}
                                    type="button"
                                    aria-label={
                                      entry
                                        ? `${date}, ${entry.moodName}`
                                        : `${date}, no reflection`
                                    }
                                    onClick={() => choosePixelDate(date)}
                                    className={`block h-2.5 w-full rounded-[3px] ${entry ? moodPixelClass(entry.moodName) : 'bg-brand-border/40'}`}
                                  />
                                );
                              },
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {selectedPixelEntry ? (
                  <article className="surface-paper relative mt-5 border-l-2 border-brand-pink/30 px-5 py-4">
                    <button
                      type="button"
                      aria-label="Close memory preview"
                      onClick={() => {
                        setSelectedPixelEntry(null);
                        setSelectedPixelDate('');
                      }}
                      className="absolute right-2 top-2 p-2 text-brand-text-muted"
                    >
                      <X className="h-4 w-4" />
                    </button>
                    <p className="text-xs font-bold text-brand-text-muted">
                      {selectedPixelDate} · {selectedPixelEntry.moodName}
                    </p>
                    <h3 className="mt-2 font-serif-diary text-xl font-semibold">
                      {selectedPixelEntry.title}
                    </h3>
                    <p className="mt-2 line-clamp-3 text-sm leading-relaxed text-brand-text-muted">
                      {richTextHtmlToPlainText(selectedPixelEntry.body)}
                    </p>
                    <AppButton
                      className="mt-4"
                      onClick={() =>
                        onNavigate(
                          'diaries',
                          'diaryDetail',
                          selectedPixelEntry.diaryId,
                          selectedPixelEntry.id,
                        )
                      }
                    >
                      Open memory
                      <ArrowRight className="h-4 w-4" />
                    </AppButton>
                  </article>
                ) : selectedPixelDate ? (
                  <article className="mt-5 border-l-2 border-brand-border pl-4">
                    <p className="text-sm font-bold">No reflection on {selectedPixelDate}</p>
                    <p className="mt-1 text-sm text-brand-text-muted">
                      An empty day is not a missed goal. Write only if this moment feels right.
                    </p>
                    <AppButton
                      className="mt-3"
                      onClick={() => createReflectionForDate(selectedPixelDate)}
                    >
                      Create reflection
                    </AppButton>
                  </article>
                ) : null}
              </section>
            </main>

            <aside className="space-y-8 xl:border-l xl:border-brand-border/60 xl:pl-8">
              <section>
                <h2 className="type-section-title font-bold">Mood landscape</h2>
                <p className="mt-1 text-sm text-brand-text-muted">
                  Descriptive labels from available entries—not a diagnosis.
                </p>
                <div className="mt-5 space-y-4">
                  {moodData.slice(0, 6).map((item) => (
                    <div key={item.name}>
                      <ProgressIndicator
                        value={item.percentage}
                        label={`${item.name} · ${item.count}`}
                      />
                    </div>
                  ))}
                </div>
                {moodCorrelations.length > 0 && (
                  <div className="mt-6 border-t border-brand-border/60 pt-4">
                    <p className="text-xs font-bold text-brand-pink">Observed together</p>
                    {moodCorrelations.map((item) => (
                      <p
                        key={`${item.mood}-${item.tag}`}
                        className="mt-2 text-sm leading-relaxed text-brand-text-muted"
                      >
                        {item.mood} and #{item.tag} appeared together in {item.count} available
                        entries.
                      </p>
                    ))}
                  </div>
                )}
              </section>
              <section className="border-t border-brand-border/60 pt-6">
                <h2 className="type-section-title font-bold">Themes</h2>
                <div className="mt-5 space-y-4">
                  {topTags.map((item) => (
                    <div key={item.tag}>
                      <ProgressIndicator
                        value={item.percentage}
                        label={`#${item.tag} · ${item.count}`}
                      />
                    </div>
                  ))}
                  {topTags.length === 0 && (
                    <p className="text-sm text-brand-text-muted">No recurring tags yet.</p>
                  )}
                </div>
              </section>
            </aside>
          </div>

          {photos.length > 0 && (
            <section>
              <div className="flex items-end justify-between">
                <div>
                  <h2 className="type-section-title font-bold">Photo memories</h2>
                  <p className="mt-1 text-sm text-brand-text-muted">
                    A few visual moments from recent pages.
                  </p>
                </div>
                <span className="text-xs font-bold text-brand-text-muted">
                  {photos.length} shown
                </span>
              </div>
              <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
                {photos.map((photo, index) => (
                  <button
                    key={`${photo.src}-${index}`}
                    type="button"
                    onClick={() =>
                      onNavigate('diaries', 'diaryDetail', photo.diaryId, photo.entryId)
                    }
                    className="group relative aspect-square overflow-hidden rounded-[var(--radius-card)]"
                  >
                    <SyncedImage
                      src={photo.src}
                      alt=""
                      className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                      label="photo memory"
                    />
                    <span className="surface-glass-strong absolute inset-x-2 bottom-2 rounded-full px-2 py-1 text-xs font-bold">
                      {photo.date}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}
          <details className="border-y border-brand-border/60 py-4">
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between text-sm font-bold">
              Detailed observations
              <ChevronDown className="h-4 w-4" />
            </summary>
            <div className="grid gap-6 py-5 md:grid-cols-2">
              <section>
                <h3 className="type-card-title font-bold">Topics with selected moods</h3>
                <p className="mt-1 text-sm text-brand-text-muted">
                  These labels appeared together; the pattern does not imply cause.
                </p>
                <div className="mt-4 space-y-2">
                  {getInsightCorrelation().map((item) => (
                    <p
                      key={item.tag}
                      className="flex justify-between border-b border-brand-border/40 py-2 text-sm"
                    >
                      <span>#{item.tag}</span>
                      <span className="text-brand-text-muted">{item.count} times</span>
                    </p>
                  ))}
                </div>
              </section>
              <section>
                <h3 className="type-card-title font-bold">Available data</h3>
                <dl className="mt-4 divide-y divide-brand-border/40 text-sm">
                  <div className="flex justify-between py-2">
                    <dt>Entries</dt>
                    <dd>{entries.length}</dd>
                  </div>
                  <div className="flex justify-between py-2">
                    <dt>Notes</dt>
                    <dd>{notes.length}</dd>
                  </div>
                  <div className="flex justify-between py-2">
                    <dt>Photos</dt>
                    <dd>{totalPhotos}</dd>
                  </div>
                </dl>
              </section>
            </div>
          </details>
        </>
      )}
    </div>
  );
}
