import React, { useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { 
  Flame, BookOpen, Camera, BarChart2,
  Settings, Award, ArrowRight,
  Sparkles, X, Calendar, Grid, ChevronDown
} from 'lucide-react';
import { Diary, Entry, PartitionHydrationState, ResponsiveLayout } from '../types';
import { calculateStreak } from '../domain/journalCatalog';
import { richTextHtmlToPlainText } from '../domain/richTextSanitizer';
import SyncedImage from './SyncedImage';
import { useScreenPerformance } from '../hooks/useScreenPerformance';
import { diaryRepository } from '../repositories';
import type { EntrySummary, GlobalStatistics, NoteSummary } from '../repositories/DiaryRepository';

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
    promptText?: string
  ) => void;
}

export default function StatsScreen({
  diaries,
  excludeDiaryIds = [],
  archiveMonths = [],
  layout = 'mobile',
  onNavigate
}: StatsScreenProps) {
  useScreenPerformance('stats');
  const [entries, setEntries] = useState<EntrySummary[]>([]);
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [globalStats, setGlobalStats] = useState<GlobalStatistics | null>(null);
  const [streak, setStreak] = useState<number>(0);
  const [totalPhotos, setTotalPhotos] = useState<number>(0);
  const [selectedPixelYear, setSelectedPixelYear] = useState<number>(() => new Date().getFullYear());
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
        const items: EntrySummary[] = []; let cursor: string | undefined;
        do { const page = await diaryRepository.searchEntries({ ...filters, includeBody: false, limit: 500, cursor }); items.push(...page.items); cursor = page.nextCursor; } while (cursor);
        return items;
      };
      const loadNotes = async () => {
        const items: NoteSummary[] = []; let cursor: string | undefined;
        do { const page = await diaryRepository.listNotes({ includeBody: false, limit: 500, cursor }); items.push(...page.items as NoteSummary[]); cursor = page.nextCursor; } while (cursor);
        return items;
      };
      const [entryItems, noteItems, nextGlobalStats] = await Promise.all([loadEntries(), loadNotes(), diaryRepository.getGlobalStatistics(filters)]);
      if (cancelled) return;
      setEntries(entryItems);
      setNotes(noteItems);
      setGlobalStats(nextGlobalStats);
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
    entries.forEach(e => {
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
    entries.forEach(e => {
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
      Joyful: '😊', Calm: '😌', Sad: '😢', Anxious: '😟', Excited: '🤩', Reflective: '💭', Tired: '😴', Creative: '🎨'
    };

    entries.forEach(e => {
      const mood = e.moodName || 'Reflective';
      const emoji = e.moodEmoji || defaultEmojis[mood] || '💭';
      if (!counts[mood]) {
        counts[mood] = { count: 0, emoji };
      }
      counts[mood].count += 1;
    });

    const total = entries.length || 1;
    return Object.entries(counts).map(([name, data]) => ({
      name,
      emoji: data.emoji,
      count: data.count,
      percentage: Math.round((data.count / total) * 100)
    })).sort((a, b) => b.count - a.count);
  };

  const getMoodTagCorrelations = () => {
    if (entries.length < 5) return [];
    const correlation: { [mood: string]: { [tag: string]: number } } = {};
    
    entries.forEach(e => {
      const mood = e.moodName;
      if (!mood) return;
      if (!correlation[mood]) {
        correlation[mood] = {};
      }
      e.tags.forEach(t => {
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
          count: sortedTags[0][1]
        });
      }
    });

    return insights.slice(0, 3);
  };

  const getInsightCorrelation = () => {
    if (entries.length < 5) return [];
    const highMoods = ['Joyful', 'Calm', 'Excited', 'Creative'];
    const tagScores: { [tag: string]: number } = {};
    
    entries.forEach(e => {
      const isHighMood = highMoods.some(hm => hm.toLowerCase() === (e.moodName || '').toLowerCase());
      if (isHighMood && e.tags) {
        e.tags.forEach(t => {
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
      const dateStr = d.toISOString().split('T')[0];
      
      // Count entries on this date
      const entriesOnDate = entries.filter(e => e.date === dateStr).length;
      const notesOnDate = notes.filter(n => new Date(n.updatedAt).toISOString().split('T')[0] === dateStr).length;
      const weight = entriesOnDate * 2 + notesOnDate; // formal entries weigh more
      
      list.push({
        date: dateStr,
        dayNum: d.getDate(),
        count: entriesOnDate + notesOnDate,
        weight: Math.min(weight, 4) // cap weight at 4 for color rendering
      });
    }
    return list;
  };

  // Tag frequency ranking
  const getTopTags = () => {
    const counts: { [key: string]: number } = {};
    entries.forEach(e => {
      e.tags.forEach(t => {
        counts[t] = (counts[t] || 0) + 1;
      });
    });
    notes.forEach(n => {
      n.tags.forEach(t => {
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
      percentage: Math.round((count / maxCount) * 100)
    }));
  };

  // Get all photo memories chronologically
  const getPhotoMemories = () => {
    const photos: { src: string; date: string; entryId: string; diaryId: string }[] = [];
    
    const sortedEntries = [...entries].sort((a, b) => b.date.localeCompare(a.date));
    
    sortedEntries.forEach(e => {
      if (e.photoUris) {
        e.photoUris.forEach(src => {
          photos.push({
            src,
            date: e.date,
            entryId: e.id,
            diaryId: e.diaryId
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
  const hasUnhydratedArchives = archiveMonths.some(month => month.status !== 'hydrated');
  const entryScopeLabel = hasUnhydratedArchives ? 'Downloaded Entries' : 'Total Entries';
  const photoScopeLabel = hasUnhydratedArchives ? 'Downloaded Photos' : 'Visual Memories';
  const scopeHint = 'Insights reflect entries available on this device. Restore older archive months to complete these totals.';

  if (layout === 'desktop') {
    const dominantMood = moodData[0];

    return (
      <div className="space-y-7 pb-8">
        <header className="flex flex-wrap items-start justify-between gap-5 xl:gap-6">
          <div>
            <h1 className="font-serif-diary text-4xl font-semibold tracking-tight text-brand-plum dark:text-brand-text xl:text-5xl">Insights</h1>
            <p className="mt-2 max-w-2xl text-lg leading-relaxed text-brand-text-muted">
              Taking a moment to observe the journey of your thoughts over time.
            </p>
          </div>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => onNavigate('stats', 'appSettings')}
              className="rounded-full border border-brand-border bg-white/60 px-5 py-3 text-sm font-bold text-brand-sage hover:bg-white"
            >
              Settings
            </button>
            <button
              type="button"
              onClick={() => {
                const targetDiary = diaries[0];
                if (targetDiary) onNavigate('diaries', 'entryEditor', targetDiary.id);
                else onNavigate('diaries');
              }}
              className="rounded-full bg-brand-sage px-5 py-3 text-sm font-bold text-white hover:bg-brand-sage-dark"
            >
              New Entry
            </button>
          </div>
        </header>

        {hasUnhydratedArchives && (
          <div className="rounded-2xl border border-brand-sage/20 bg-brand-sage-light/20 px-4 py-3 text-sm font-semibold text-brand-sage-dark">
            {scopeHint}
          </div>
        )}

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[210px_minmax(0,1fr)] 2xl:grid-cols-[240px_minmax(0,1fr)_260px] 2xl:gap-7">
          <aside className="grid grid-cols-3 gap-4 xl:block xl:space-y-5">
            <section className="rounded-[24px] border border-brand-border bg-white/74 p-5 text-center shadow-[0_14px_38px_rgba(62,36,41,0.07)] dark:bg-brand-card-bg/70">
              <Flame className="mx-auto h-8 w-8 text-brand-pink" />
              <p className="mt-5 text-xs font-bold uppercase tracking-[0.18em] text-brand-text-muted">Current Streak</p>
              <p className="mt-3 font-serif-diary text-5xl font-semibold text-brand-plum dark:text-brand-text">{streak}</p>
              <p className="mt-2 text-sm text-brand-text-muted">Days of mindful writing</p>
            </section>
            <section className="rounded-[24px] border border-brand-border bg-white/74 p-5 shadow-sm dark:bg-brand-card-bg/70">
              <p className="text-sm font-bold text-brand-text-muted">{entryScopeLabel}</p>
              <p className="mt-4 font-serif-diary text-4xl font-semibold text-brand-plum dark:text-brand-text">{entries.length}</p>
            </section>
            <section className="rounded-[24px] border border-brand-border bg-white/74 p-5 shadow-sm dark:bg-brand-card-bg/70">
              <p className="text-sm font-bold text-brand-text-muted">{photoScopeLabel}</p>
              <p className="mt-4 font-serif-diary text-4xl font-semibold text-brand-plum dark:text-brand-text">{totalPhotos} Photos</p>
            </section>
          </aside>

          <main className="space-y-7">
            <section className="rounded-[28px] border border-brand-border bg-white/76 p-6 shadow-[0_18px_55px_rgba(62,36,41,0.08)] dark:bg-brand-card-bg/72">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 className="font-serif-diary text-3xl font-bold text-brand-plum dark:text-brand-text">Year in Pixels</h2>
                  <p className="mt-1 text-sm text-brand-text-muted">A calm map of your emotional rhythm.</p>
                </div>
                <select
                  aria-label="Insight year"
                  value={selectedPixelYear}
                  onChange={(event) => setSelectedPixelYear(parseInt(event.target.value, 10))}
                  className="rounded-full border border-brand-border bg-brand-bg/70 px-4 py-2 text-sm font-bold text-brand-sage outline-none"
                >
                  {availableYears.map(year => <option key={year} value={year}>{year}</option>)}
                </select>
              </div>

              <div className="mt-7 grid grid-cols-12 gap-1">
                {Array.from({ length: 12 }, (_, monthIdx) => (
                  <div key={monthIdx} className="space-y-0.5">
                    {Array.from({ length: 31 }, (_, dayIdx) => {
                      const day = dayIdx + 1;
                      const date = `${selectedPixelYear}-${String(monthIdx + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                      const entry = entries.find(item => item.date === date);
                      const mood = (entry?.moodName || '').toLowerCase();
                      const colorClass = entry
                        ? mood.includes('calm') ? 'bg-[#d8f3dc]' :
                          mood.includes('joy') || mood.includes('happy') ? 'bg-[#ffccd5]' :
                          mood.includes('sad') ? 'bg-[#cfe2ff]' :
                          mood.includes('anxious') ? 'bg-[#fff3cd]' :
                          'bg-brand-sage-light'
                        : 'bg-brand-border/45';
                      return (
                        <button
                          key={date}
                          type="button"
                          onClick={() => entry ? onNavigate('diaries', 'diaryDetail', entry.diaryId, entry.id) : undefined}
                          className={`h-1.5 w-full rounded-[4px] transition-transform hover:scale-125 ${colorClass}`}
                          title={entry ? `${date}: ${entry.title}` : `${date}: No entry`}
                        />
                      );
                    })}
                  </div>
                ))}
              </div>
              <div className="mt-4 grid grid-cols-12 gap-2 text-center text-xs font-bold uppercase tracking-wider text-brand-text-muted">
                {['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].map(month => <span key={month}>{month}</span>)}
              </div>
            </section>

            <section className="rounded-[28px] border border-brand-border bg-white/76 p-6 shadow-[0_18px_55px_rgba(62,36,41,0.07)] dark:bg-brand-card-bg/72">
              <div className="flex items-center justify-between">
                <h2 className="font-serif-diary text-3xl font-bold text-brand-plum dark:text-brand-text">Writing Intensity</h2>
                <span className="text-sm font-bold text-brand-text-muted">Last 30 Days</span>
              </div>
              <div className="mt-8 flex h-36 items-end gap-2 rounded-2xl bg-brand-bg/25 px-3 pt-4">
                {heatmap.map(item => (
                  <div key={item.date} className="flex min-w-0 flex-1 flex-col items-center gap-2">
                    <div
                      className="w-full rounded-t-lg bg-brand-sage-light transition-all hover:bg-brand-sage"
                      style={{ height: `${Math.max(10, item.weight * 22)}%` }}
                      title={`${item.date}: ${item.count} items`}
                    />
                  </div>
                ))}
              </div>
            </section>
          </main>

          <aside className="grid gap-5 xl:col-start-2 xl:row-start-2 xl:grid-cols-2 2xl:col-start-auto 2xl:row-start-auto 2xl:sticky 2xl:top-6 2xl:block 2xl:space-y-5">
            <section className="rounded-[24px] border border-brand-border bg-white/74 p-5 shadow-[0_14px_40px_rgba(62,36,41,0.07)] dark:bg-brand-card-bg/72">
              <h2 className="font-serif-diary text-2xl font-bold text-brand-plum dark:text-brand-text">Mood Mix</h2>
              <div className="mx-auto mt-7 flex h-40 w-40 items-center justify-center rounded-full border-[24px] border-brand-sage-light bg-white text-center">
                <div>
                  <p className="font-serif-diary text-2xl font-bold text-brand-plum">{dominantMood?.name || 'None'}</p>
                  <p className="text-xs font-bold uppercase tracking-widest text-brand-text-muted">Dominant</p>
                </div>
              </div>
              <div className="mt-6 space-y-3">
                {moodData.slice(0, 4).map(item => (
                  <div key={item.name} className="flex items-center justify-between text-sm">
                    <span className="font-bold text-brand-plum dark:text-brand-text">{item.emoji} {item.name}</span>
                    <span className="font-bold text-brand-text-muted">{item.percentage}%</span>
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-[24px] border border-brand-border bg-white/74 p-5 shadow-sm dark:bg-brand-card-bg/72">
              <h2 className="font-serif-diary text-2xl font-bold text-brand-plum dark:text-brand-text">Top Tags</h2>
              <div className="mt-5 space-y-4">
                {topTags.map(item => (
                  <div key={item.tag}>
                    <div className="flex justify-between text-sm font-bold text-brand-plum dark:text-brand-text">
                      <span>#{item.tag}</span>
                      <span>{item.count}</span>
                    </div>
                    <div className="mt-1 h-2 rounded-full bg-brand-border/50">
                      <div className="h-full rounded-full bg-brand-sage" style={{ width: `${item.percentage}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {photos.length > 0 && (
              <section className="rounded-[24px] border border-brand-border bg-white/74 p-5 shadow-sm dark:bg-brand-card-bg/72">
                <h2 className="font-serif-diary text-2xl font-bold text-brand-plum dark:text-brand-text">Recent Memories</h2>
                <div className="mt-5 grid grid-cols-2 gap-3">
                  {photos.slice(0, 4).map((photo, index) => (
                    <button key={`${photo.src}-${index}`} type="button" onClick={() => onNavigate('diaries', 'diaryDetail', photo.diaryId, photo.entryId)} className="aspect-square overflow-hidden rounded-xl border border-brand-border">
                      <SyncedImage
                        src={photo.src}
                        alt=""
                        className="h-full w-full object-cover"
                        fallbackSrc="https://images.unsplash.com/photo-1517842645767-c639042777db?w=600"
                        label="recent memory"
                      />
                    </button>
                  ))}
                </div>
              </section>
            )}
          </aside>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 font-sans pb-16">
      {/* Header */}
      <header className="flex justify-between items-center bg-brand-bg/95 backdrop-blur-md sticky top-0 py-3 z-30 border-b border-brand-rose-light/20">
        <div className="flex items-center gap-3">
          <span className="p-2 bg-brand-sage-light/20 text-brand-sage rounded-full">
            <BarChart2 className="w-5 h-5" />
          </span>
          <h1 className="font-serif-diary text-3xl text-brand-plum tracking-tight font-bold">Insights</h1>
        </div>
        <button 
          aria-label="Open settings"
          onClick={() => onNavigate('stats', 'appSettings')}
          className="p-2 text-brand-sage hover:bg-brand-blush-light rounded-full transition-all"
        >
          <Settings className="w-5 h-5" />
        </button>
      </header>

      <div className="flex flex-col gap-6">
        {hasUnhydratedArchives && (
          <div className="rounded-2xl border border-brand-sage/20 bg-brand-sage-light/20 px-4 py-3 text-xs font-semibold text-brand-sage-dark">
            {scopeHint}
          </div>
        )}

        {/* Grid statistics highlights */}
        <section className="grid grid-cols-3 gap-3">
          <div className="bg-brand-card-bg p-4 rounded-2xl border border-brand-border text-center flex flex-col gap-1 shadow-sm">
            <Flame className="w-5 h-5 text-brand-pink mx-auto fill-brand-pink" />
            <span className="text-xl font-bold text-brand-plum mt-1">{streak}</span>
            <span className="text-xs text-brand-sage font-bold uppercase tracking-wider">Streak</span>
          </div>
          
          <div className="bg-brand-card-bg p-4 rounded-2xl border border-brand-border text-center flex flex-col gap-1 shadow-sm">
            <BookOpen className="w-5 h-5 text-brand-sage mx-auto" />
            <span className="text-xl font-bold text-brand-plum mt-1">{entries.length}</span>
            <span className="text-xs text-brand-sage font-bold uppercase tracking-wider">{hasUnhydratedArchives ? 'Downloaded' : 'Entries'}</span>
          </div>

          <div className="bg-brand-card-bg p-4 rounded-2xl border border-brand-border text-center flex flex-col gap-1 shadow-sm">
            <Camera className="w-5 h-5 text-brand-pink mx-auto" />
            <span className="text-xl font-bold text-brand-plum mt-1">{totalPhotos}</span>
            <span className="text-xs text-brand-sage font-bold uppercase tracking-wider">{hasUnhydratedArchives ? 'DL Photos' : 'Photos'}</span>
          </div>
        </section>

            {/* Point 4: Mood Landscapes Analytics section */}
            <section className="bg-brand-card-bg p-5 rounded-3xl border border-brand-border journal-shadow flex flex-col gap-4 animate-fade-in">
              <div>
                <h3 className="font-serif-diary text-lg font-bold text-brand-plum">Mood Landscapes</h3>
                <p className="text-xs text-brand-sage mt-0.5">Real-time breakdown of your logged emotional states.</p>
              </div>

              <div className="flex flex-col gap-3">
                {moodData.map(item => (
                  <div key={item.name} className="flex flex-col gap-1 bg-brand-bg/15 p-2 rounded-2xl border border-brand-border/30">
                    <div className="flex justify-between items-center text-xs font-semibold text-brand-plum">
                      <span className="flex items-center gap-1.5">
                        <span className="text-sm">{item.emoji}</span>
                        <span>{item.name}</span>
                      </span>
                      <span className="text-brand-sage">{item.count} times ({item.percentage}%)</span>
                    </div>
                    <div className="w-full h-2 bg-brand-bg rounded-full overflow-hidden border border-brand-border/40 mt-1">
                      <div 
                        className="h-full bg-brand-pink rounded-full transition-all duration-1000"
                        style={{ width: `${item.percentage}%` }}
                      />
                    </div>
                  </div>
                ))}

                {moodData.length === 0 && (
                  <p className="text-xs text-brand-sage italic text-center py-4">No moods logged yet. Save a diary entry to see insights!</p>
                )}
              </div>

              {/* Correlations (Point 4) */}
              {moodCorrelations.length > 0 && (
                <div className="border-t border-brand-border/40 pt-3.5 mt-1">
                  <h4 className="text-xs font-extrabold text-brand-pink uppercase tracking-widest mb-2 flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-brand-pink" />
                    Observed together
                  </h4>
                  <div className="grid grid-cols-1 gap-2">
                    {moodCorrelations.map((c, i) => (
                      <div key={i} className="flex items-center gap-2 bg-brand-bg/50 px-3 py-2.5 rounded-xl border border-brand-border/40 text-xs text-brand-plum font-semibold leading-relaxed">
                        <span className="w-1.5 h-1.5 rounded-full bg-brand-pink flex-shrink-0" />
                        <span><strong className="text-brand-pink-dark font-bold">{c.mood}</strong> and <strong className="text-brand-sage-dark font-bold">#{c.tag}</strong> were observed together in {c.count} of {entries.length} available entries.</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </section>

                          {/* Year / Month in Pixels */}
            <section className="bg-brand-card-bg p-5 rounded-3xl border border-brand-border journal-shadow flex flex-col gap-4 animate-fade-in">
              <div className="flex flex-col sm:flex-row justify-between sm:items-center gap-3">
                <div>
                  <h3 className="font-serif-diary text-lg font-bold text-brand-plum">
                    {pixelViewMode === 'year' ? 'Year in Pixels 🌸' : 'Month in Pixels 🌸'}
                  </h3>
                  <p className="text-xs text-brand-sage mt-0.5">
                    {pixelViewMode === 'year' 
                      ? 'Your emotional history represented through tiny pastel squares.' 
                      : 'A deep-dive view of your emotional rhythm for the selected month.'}
                  </p>
                </div>
                
                {/* Mode and Year toggles */}
                <div className="flex flex-wrap items-center gap-3 self-start sm:self-auto">
                  {/* View mode toggle */}
                  <div className="flex bg-brand-bg/80 dark:bg-brand-card-bg/50 p-1 rounded-2xl border border-brand-border/60 dark:border-white/5 shadow-inner gap-0.5 animate-fade-in">
                    {[
                      { mode: 'year' as const, icon: Grid, activeBg: 'bg-brand-sage', activeShadow: 'shadow-[0_2px_8px_rgba(69,98,80,0.2)]', colorClass: 'text-brand-sage' },
                      { mode: 'month' as const, icon: Calendar, activeBg: 'bg-brand-pink', activeShadow: 'shadow-[0_2px_8px_rgba(181,66,97,0.2)]', colorClass: 'text-brand-pink' }
                    ].map(tab => {
                      const isActive = pixelViewMode === tab.mode;
                      const Icon = tab.icon;
                      return (
                        <button
                          key={tab.mode}
                          onClick={() => {
                            setPixelViewMode(tab.mode);
                            setSelectedPixelEntry(null);
                            setSelectedPixelDate('');
                          }}
                          className="relative px-3.5 py-1.5 text-xs font-bold rounded-xl capitalize transition-all flex items-center justify-center gap-1.5 cursor-pointer select-none group active:scale-[0.96]"
                        >
                          {isActive && (
                            <motion.div
                              layoutId="pixelViewModeTab"
                              className={`absolute inset-0 ${tab.activeBg} rounded-xl ${tab.activeShadow}`}
                              transition={{ type: "spring", stiffness: 380, damping: 30 }}
                            />
                          )}
                          <span className={`relative z-10 flex items-center gap-1.5 transition-all duration-300 ${
                            isActive 
                              ? 'text-white scale-[1.03]' 
                              : 'text-brand-text-muted dark:text-brand-text-muted/80 group-hover:text-brand-plum dark:group-hover:text-brand-text'
                          }`}>
                            <Icon className={`w-3 h-3 transition-transform duration-300 ${
                              isActive ? 'scale-110 text-white' : `${tab.colorClass} opacity-75 group-hover:opacity-100 group-hover:scale-110`
                            }`} />
                            <span>{tab.mode}</span>
                          </span>
                          
                          {!isActive && (
                            <div className="absolute inset-0 rounded-xl bg-brand-blush-light/0 dark:bg-white/0 group-hover:bg-brand-blush-light/40 dark:group-hover:bg-white/5 transition-colors duration-200 -z-0 pointer-events-none" />
                          )}
                        </button>
                      );
                    })}
                  </div>

                  {/* Year selector pills / dropdown adaptive container */}
                  {availableYears.length > 5 ? (
                    <div className="relative animate-fade-in">
                      <select
                        aria-label="Year in pixels"
                        value={selectedPixelYear}
                        onChange={(e) => {
                          setSelectedPixelYear(parseInt(e.target.value, 10));
                          setSelectedPixelEntry(null);
                          setSelectedPixelDate('');
                        }}
                        className="absolute inset-0 opacity-0 cursor-pointer z-10 w-full h-full"
                      >
                        {availableYears.map(yr => (
                          <option key={yr} value={yr}>
                            Year {yr}
                          </option>
                        ))}
                      </select>
                      <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-2xl border border-brand-border/60 dark:border-white/10 bg-brand-bg/80 dark:bg-brand-card-bg/50 shadow-inner text-xs font-bold text-brand-plum dark:text-brand-pink-dark">
                        <span>Year: {selectedPixelYear}</span>
                        <ChevronDown className="w-3.5 h-3.5 text-brand-sage" />
                      </div>
                    </div>
                  ) : (
                    <div className="flex bg-brand-bg/80 dark:bg-brand-card-bg/50 p-1 rounded-2xl border border-brand-border/60 dark:border-white/5 shadow-inner gap-0.5 animate-fade-in">
                      {availableYears.map((yr, idx) => {
                        const isActive = selectedPixelYear === yr;
                        const isEven = idx % 2 === 0;
                        const activeBg = isEven ? 'bg-brand-pink-dark' : 'bg-brand-sage';
                        const activeShadow = isEven ? 'shadow-[0_2px_8px_rgba(117,31,53,0.2)]' : 'shadow-[0_2px_8px_rgba(69,98,80,0.2)]';
                        
                        return (
                          <button
                            key={yr}
                            onClick={() => {
                              setSelectedPixelYear(yr);
                              setSelectedPixelEntry(null);
                              setSelectedPixelDate('');
                            }}
                            className="relative px-3 py-1.5 text-xs font-bold rounded-xl transition-all flex items-center justify-center cursor-pointer select-none group active:scale-[0.96]"
                          >
                            {isActive && (
                              <motion.div
                                layoutId="pixelYearTab"
                                className={`absolute inset-0 ${activeBg} rounded-xl ${activeShadow}`}
                                transition={{ type: "spring", stiffness: 380, damping: 30 }}
                              />
                            )}
                            <span className={`relative z-10 transition-colors duration-200 ${
                              isActive 
                                ? 'text-white scale-[1.03]' 
                                : 'text-brand-text-muted dark:text-brand-text-muted/80 group-hover:text-brand-plum dark:group-hover:text-brand-text'
                            }`}>
                              {yr}
                            </span>
                            
                            {!isActive && (
                              <div className="absolute inset-0 rounded-xl bg-brand-blush-light/0 dark:bg-white/0 group-hover:bg-brand-blush-light/40 dark:group-hover:bg-white/5 transition-colors duration-200 -z-0 pointer-events-none" />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>

              {/* Month selector line if Month mode is active */}
              {pixelViewMode === 'month' && (
                <div className="flex gap-1 overflow-x-auto no-scrollbar pb-1 border-b border-brand-border/20">
                  {['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].map((m, mIdx) => (
                    <button
                      key={mIdx}
                      onClick={() => {
                        setSelectedPixelMonth(mIdx);
                        setSelectedPixelEntry(null);
                        setSelectedPixelDate('');
                      }}
                      className={`px-2.5 py-1 text-xs font-bold rounded-lg flex-shrink-0 transition-all ${
                        selectedPixelMonth === mIdx
                          ? 'bg-brand-pink text-white shadow-sm'
                          : 'bg-brand-bg/50 text-brand-sage hover:bg-brand-blush-light border border-brand-border/30 dark:bg-brand-card-bg/20'
                      }`}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              )}

              {/* Grid representations */}
              {pixelViewMode === 'year' ? (
                /* Year View Grid representation */
                <div className="flex flex-col gap-2 bg-brand-bg/20 p-4 rounded-2xl border border-brand-border/30 overflow-x-auto no-scrollbar">
                  {/* Month labels J F M ... */}
                  <div className="flex gap-1.5 pl-6">
                    {['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'].map((m, mIdx) => (
                      <span key={mIdx} className="w-5 text-center text-xs font-bold text-brand-sage">
                        {m}
                      </span>
                    ))}
                  </div>

                  <div className="flex flex-col gap-1.5">
                    {Array.from({ length: 31 }, (_, dayIdx) => {
                      const dayNum = dayIdx + 1;
                      return (
                        <div key={dayNum} className="flex gap-1.5 items-center">
                          {/* Day Row Label */}
                          <span className="w-4 text-right text-xs font-bold text-brand-sage pr-1.5">
                            {dayNum}
                          </span>

                          {/* 12 Months squares for this day */}
                          {Array.from({ length: 12 }, (_, monthIdx) => {
                            const daysInMonths = [
                              31, 
                              (selectedPixelYear % 4 === 0 && selectedPixelYear % 100 !== 0) || (selectedPixelYear % 400 === 0) ? 29 : 28, 
                              31, 30, 31, 30, 31, 31, 30, 31, 30, 31
                            ];
                            const isValidDay = dayNum <= daysInMonths[monthIdx];
                            
                            if (!isValidDay) {
                              return <div key={monthIdx} className="w-5 h-5 rounded-md bg-transparent" />;
                            }

                            // Find entry
                            const formattedM = String(monthIdx + 1).padStart(2, '0');
                            const formattedD = String(dayNum).padStart(2, '0');
                            const targetDate = `${selectedPixelYear}-${formattedM}-${formattedD}`;
                            const entry = entries.find(e => e.date === targetDate);

                            let bgClass = 'bg-brand-bg/50 border-brand-border/30';
                            if (entry) {
                              const normMood = (entry.moodName || '').toLowerCase();
                              if (normMood.includes('joyful') || normMood.includes('happy')) bgClass = 'bg-[#ffccd5] border-[#ffa6b6]';
                              else if (normMood.includes('calm') || normMood.includes('peaceful')) bgClass = 'bg-[#d8f3dc] border-[#b7e4c7]';
                              else if (normMood.includes('sad') || normMood.includes('gloomy')) bgClass = 'bg-[#cfe2ff] border-[#9ec5fe]';
                              else if (normMood.includes('anxious') || normMood.includes('worried')) bgClass = 'bg-[#fff3cd] border-[#ffe69c]';
                              else if (normMood.includes('excited')) bgClass = 'bg-[#f3e5f5] border-[#e1bee7]';
                              else if (normMood.includes('reflective')) bgClass = 'bg-[#e9eae1] border-[#d7dbce]';
                              else if (normMood.includes('tired')) bgClass = 'bg-[#e2e3e5] border-[#d6d8db]';
                              else if (normMood.includes('creative')) bgClass = 'bg-[#e0f7fa] border-[#b2ebf2]';
                              else bgClass = 'bg-[#ffccd5] border-[#ffa6b6]';
                            }

                            return (
                              <div
                                key={monthIdx}
                                className={`w-5 h-5 rounded-md border text-xs flex items-center justify-center font-semibold ${bgClass} ${
                                  selectedPixelDate === `${selectedPixelYear}-${formattedM}-${formattedD}` ? 'ring-1 ring-brand-sage' : ''
                                }`}
                                title={
                                  entry 
                                    ? `${selectedPixelYear}-${formattedM}-${formattedD}: ${entry.title} (${entry.moodEmoji} ${entry.moodName})` 
                                    : `${selectedPixelYear}-${formattedM}-${formattedD}: No reflection logged`
                                }
                              >
                                {entry ? entry.moodEmoji : ''}
                              </div>
                            );
                          })}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                /* Month View Calendar */
                <div className="flex flex-col gap-3 bg-brand-bg/20 p-4 rounded-2xl border border-brand-border/30">
                  {/* Month Header Label */}
                  <div className="text-center font-serif-diary text-sm font-bold text-brand-plum py-0.5">
                    {['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][selectedPixelMonth]} {selectedPixelYear}
                  </div>

                  {/* Weekdays Row */}
                  <div className="grid grid-cols-7 gap-2 text-center text-xs font-bold text-brand-sage border-b border-brand-border/20 pb-2">
                    {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map(day => (
                      <span key={day}>{day}</span>
                    ))}
                  </div>

                  {/* Days Grid */}
                  <div className="grid grid-cols-7 gap-2">
                    {(() => {
                      const firstDayOfWeek = new Date(selectedPixelYear, selectedPixelMonth, 1).getDay();
                      const totalDays = new Date(selectedPixelYear, selectedPixelMonth + 1, 0).getDate();
                      const cells = [];

                      // Spacer cells
                      for (let i = 0; i < firstDayOfWeek; i++) {
                        cells.push(
                          <div key={`empty-${i}`} className="aspect-square rounded-xl bg-transparent border border-dashed border-brand-border/10" />
                        );
                      }

                      // Calendar days cells
                      for (let d = 1; d <= totalDays; d++) {
                        const formattedM = String(selectedPixelMonth + 1).padStart(2, '0');
                        const formattedD = String(d).padStart(2, '0');
                        const targetDate = `${selectedPixelYear}-${formattedM}-${formattedD}`;
                        const entry = entries.find(e => e.date === targetDate);

                        let bgClass = 'bg-brand-bg/50 border-brand-border/30 hover:bg-brand-blush-light dark:hover:bg-brand-blush-light/10';
                        if (entry) {
                          const normMood = (entry.moodName || '').toLowerCase();
                          if (normMood.includes('joyful') || normMood.includes('happy')) bgClass = 'bg-[#ffccd5] border-[#ffa6b6]';
                          else if (normMood.includes('calm') || normMood.includes('peaceful')) bgClass = 'bg-[#d8f3dc] border-[#b7e4c7]';
                          else if (normMood.includes('sad') || normMood.includes('gloomy')) bgClass = 'bg-[#cfe2ff] border-[#9ec5fe]';
                          else if (normMood.includes('anxious') || normMood.includes('worried')) bgClass = 'bg-[#fff3cd] border-[#ffe69c]';
                          else if (normMood.includes('excited')) bgClass = 'bg-[#f3e5f5] border-[#e1bee7]';
                          else if (normMood.includes('reflective')) bgClass = 'bg-[#e9eae1] border-[#d7dbce]';
                          else if (normMood.includes('tired')) bgClass = 'bg-[#e2e3e5] border-[#d6d8db]';
                          else if (normMood.includes('creative')) bgClass = 'bg-[#e0f7fa] border-[#b2ebf2]';
                          else bgClass = 'bg-[#ffccd5] border-[#ffa6b6]';
                        }

                        cells.push(
                          <button
                            type="button"
                            key={`day-${d}`}
                            onClick={() => {
                              if (entry) {
                                void selectPixelEntry(entry, targetDate);
                              } else {
                                setSelectedPixelEntry(null);
                                setSelectedPixelDate(targetDate);
                              }
                            }}
                            className={`min-h-11 aspect-square rounded-xl border flex flex-col justify-between p-1.5 cursor-pointer transition-colors md:min-h-9 ${bgClass} ${
                              selectedPixelDate === targetDate ? 'ring-2 ring-brand-sage ring-offset-2 dark:ring-offset-[#131012]' : ''
                            }`}
                            title={entry ? `${entry.title} (${entry.moodEmoji} ${entry.moodName})` : 'No reflection logged'}
                          >
                            <span className="text-xs font-bold text-brand-text/75 self-start">
                              {d}
                            </span>
                            {entry ? (
                              <span className="text-base text-center w-full self-center">
                                {entry.moodEmoji}
                              </span>
                            ) : (
                              <span className="text-xs text-brand-text/10 text-center w-full self-center">
                                •
                              </span>
                            )}
                          </button>
                        );
                      }

                      return cells;
                    })()}
                  </div>
                </div>
              )}

              {/* Pixel Legend */}
              <div className="flex flex-wrap gap-2.5 items-center justify-center text-xs font-bold text-brand-sage uppercase tracking-wider pt-2 border-t border-brand-border/40 mt-1">
                <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-[#ffccd5] border border-[#ffa6b6]" /> Joyful</span>
                <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-[#d8f3dc] border border-[#b7e4c7]" /> Calm</span>
                <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-[#cfe2ff] border border-[#9ec5fe]" /> Sad</span>
                <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-[#fff3cd] border border-[#ffe69c]" /> Anxious</span>
                <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-[#f3e5f5] border border-[#e1bee7]" /> Excited</span>
                <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-[#e9eae1] border border-[#d7dbce]" /> Reflective</span>
              </div>

              {/* Memory preview card when pixel clicked */}
              {selectedPixelEntry ? (
                <div className="bg-white/80 dark:bg-white/5 p-4 rounded-2xl border border-brand-border/60 flex flex-col gap-3 animate-fade-in relative mt-1">
                  <button 
                    onClick={() => { setSelectedPixelEntry(null); setSelectedPixelDate(''); }}
                    className="absolute top-3 right-3 text-brand-sage hover:text-brand-pink transition-colors"
                  >
                    <X className="w-4 h-4" />
                  </button>
                  <div className="flex justify-between items-start pr-6">
                    <div>
                      <h4 className="font-serif-diary text-sm font-bold text-brand-plum italic">{selectedPixelEntry.title}</h4>
                      <p className="text-xs text-brand-sage font-bold uppercase tracking-wider">{selectedPixelDate}</p>
                    </div>
                    <span className="text-xs px-2 py-0.5 bg-brand-pink/10 text-brand-pink-dark rounded-full font-bold flex items-center gap-1">
                      <span>{selectedPixelEntry.moodEmoji}</span>
                      <span>{selectedPixelEntry.moodName}</span>
                    </span>
                  </div>
                  <p className="text-xs text-brand-plum/85 line-clamp-3 leading-relaxed font-serif-diary italic">
                    {richTextHtmlToPlainText(selectedPixelEntry.body)}
                  </p>
                  <div className="flex justify-between items-center pt-2 border-t border-brand-border/40">
                    <div className="flex gap-1.5">
                      {selectedPixelEntry.tags.map(t => (
                        <span key={t} className="text-xs font-bold text-brand-sage bg-brand-sage-light/10 px-2 py-0.5 rounded-full border border-brand-border/30">
                          #{t}
                        </span>
                      ))}
                    </div>
                    <button
                      onClick={() => onNavigate('diaries', 'diaryDetail', selectedPixelEntry.diaryId, selectedPixelEntry.id)}
                      className="text-xs font-bold text-brand-pink hover:text-brand-pink-dark flex items-center gap-1"
                    >
                      <span>Jump to Memory</span>
                      <ArrowRight className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              ) : selectedPixelDate ? (
                <div className="bg-white/80 dark:bg-white/5 p-4 rounded-2xl border border-brand-border/60 flex flex-col gap-3 animate-fade-in relative mt-1">
                  <button 
                    onClick={() => { setSelectedPixelDate(''); }}
                    className="absolute top-3 right-3 text-brand-sage hover:text-brand-pink transition-colors"
                  >
                    <X className="w-4 h-4" />
                  </button>
                  <div>
                    <h4 className="font-serif-diary text-sm font-bold text-brand-plum italic">No reflection logged</h4>
                    <p className="text-xs text-brand-sage font-bold uppercase tracking-wider">{selectedPixelDate}</p>
                  </div>
                  <p className="text-xs text-brand-sage/80 leading-relaxed font-serif-diary italic">
                    There is no diary entry or voice memory logged for this date. Would you like to create a new reflection?
                  </p>
                  <button
                    onClick={() => {
                      const targetDiary = diaries[0];
                      if (targetDiary) {
                        onNavigate('diaries', 'entryEditor', targetDiary.id, '', selectedPixelDate);
                      } else {
                        onNavigate('diaries');
                      }
                    }}
                    className="mt-1 bg-brand-sage hover:bg-brand-sage-dark text-white text-xs font-bold py-2 px-4 rounded-xl flex items-center justify-center gap-2 self-start transition-all"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>Create Reflection</span>
                  </button>
                </div>
              ) : (
                <div className="text-center py-5 bg-brand-bg/25 border border-dashed border-brand-border/60 rounded-2xl text-xs text-brand-sage italic mt-1">
                  Tap any colored pixel on the grid to instantly load that day's voice/text memory preview card.
                </div>
              )}

              {/* Emotional Catalysts Panel */}
              <div className="bg-brand-sage-light/10 p-3.5 rounded-2xl border border-brand-border/40 mt-1">
                <h4 className="text-xs font-extrabold text-brand-pink uppercase tracking-widest mb-1.5 flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-brand-pink fill-brand-pink/20" />
                  Topics observed with selected moods
                </h4>
                <p className="text-xs text-brand-sage leading-normal mb-3">
                  These topics were observed together with Joyful, Calm, Excited, or Creative labels. This is descriptive, not causal. Sample: {entries.length} available entries.
                </p>
                <div className="flex flex-col gap-2">
                  {getInsightCorrelation().map((c, i) => (
                    <div key={i} className="flex justify-between items-center bg-white/75 dark:bg-white/5 px-3 py-2 rounded-xl border border-brand-border/40 text-xs font-semibold text-brand-plum">
                      <span className="text-brand-sage-dark font-bold">#{c.tag}</span>
                      <span className="text-brand-sage text-xs font-bold">observed together {c.count} times</span>
                    </div>
                  ))}
                  {getInsightCorrelation().length === 0 && (
                    <p className="text-xs text-brand-sage italic text-center py-2">No catalyst data available yet. Keep writing!</p>
                  )}
                </div>
              </div>
            </section>

            {/* Heatmap Section */}
            <section aria-label="Journaling frequency" className="bg-brand-card-bg p-5 rounded-3xl border border-brand-border journal-shadow flex flex-col gap-4">
              <div className="flex justify-between items-center">
                <div>
                  <h3 className="font-serif-diary text-lg font-bold text-brand-plum">Writing Frequency</h3>
                  <p className="text-xs text-brand-sage mt-0.5">Your daily reflections over the past 30 days.</p>
                </div>
                <Award className="w-5 h-5 text-brand-pink" />
              </div>

              {/* Heatmap Grid */}
              <div className="grid grid-cols-10 gap-2.5 py-2">
                {heatmap.map((item) => {
                  const bgClass = 
                    item.weight === 0 ? 'bg-brand-bg border-brand-border/40' :
                    item.weight === 1 ? 'bg-brand-blush-light text-brand-pink/50' :
                    item.weight === 2 ? 'bg-brand-blush-dark text-brand-pink/70' :
                    item.weight === 3 ? 'bg-brand-pink/40 text-brand-pink-dark' :
                    'bg-brand-pink text-white';

                  return (
                    <div 
                      key={item.date}
                      className={`aspect-square rounded-xl border flex items-center justify-center text-xs font-bold shadow-sm transition-transform hover:scale-115 relative group cursor-pointer ${bgClass}`}
                      title={`${item.date}: ${item.count} items written`}
                    >
                      {item.dayNum}
                      <span className="absolute bottom-full left-1/2 transform -translate-x-1/2 bg-black text-white text-xs px-1.5 py-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none mb-1 z-10">
                        {item.count} entries
                      </span>
                    </div>
                  );
                })}
              </div>

              {/* Heatmap Legend */}
              <div className="flex justify-end gap-1.5 items-center text-xs font-bold text-brand-sage uppercase tracking-wider pt-2 border-t border-brand-border/40 mt-1">
                <span>Less</span>
                <div className="w-3.5 h-3.5 bg-brand-bg border border-brand-border/40 rounded-md" />
                <div className="w-3.5 h-3.5 bg-brand-blush-light rounded-md" />
                <div className="w-3.5 h-3.5 bg-brand-blush-dark rounded-md" />
                <div className="w-3.5 h-3.5 bg-brand-pink rounded-md" />
                <span>More</span>
              </div>
            </section>

            {/* Top Tag progress charts */}
            <section className="bg-brand-card-bg p-5 rounded-3xl border border-brand-border journal-shadow flex flex-col gap-4">
              <div>
                <h3 className="font-serif-diary text-lg font-bold text-brand-plum">Top Tag Topics</h3>
                <p className="text-xs text-brand-sage mt-0.5">Frequently logged tag elements from diaries & notes.</p>
              </div>

              <div className="flex flex-col gap-3.5">
                {topTags.map(item => (
                  <div key={item.tag} className="flex flex-col gap-1">
                    <div className="flex justify-between items-center text-xs font-semibold text-brand-plum">
                      <span>#{item.tag}</span>
                      <span className="text-brand-sage">{item.count} items</span>
                    </div>
                    <div className="w-full h-2.5 bg-brand-bg rounded-full overflow-hidden border border-brand-border/50">
                      <div 
                        className="h-full bg-brand-sage rounded-full transition-all duration-1000"
                        style={{ width: `${item.percentage}%` }}
                      />
                    </div>
                  </div>
                ))}

                {topTags.length === 0 && (
                  <p className="text-xs text-brand-sage italic text-center py-6">No tags logged yet. Try adding tags in editor!</p>
                )}
              </div>
            </section>

            {/* Photo Memories Gallery */}
            {photos.length > 0 && (
              <section className="flex flex-col gap-3">
                <div className="flex justify-between items-end">
                  <h3 className="font-serif-diary text-lg font-bold text-brand-plum">Photo Memories</h3>
                  <span className="text-xs text-brand-sage font-bold uppercase tracking-widest">{photos.length} Captured</span>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  {photos.map((photo, index) => (
                    <div 
                      key={index}
                      onClick={() => onNavigate('diaries', 'diaryDetail', photo.diaryId, photo.entryId)}
                      className="aspect-square rounded-2xl overflow-hidden relative shadow-sm border border-brand-border cursor-pointer group hover:shadow-md transition-all"
                    >
                      <SyncedImage
                        src={photo.src}
                        alt=""
                        className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                        fallbackSrc="https://images.unsplash.com/photo-1517842645767-c639042777db?w=600"
                        label="photo memory"
                      />
                      <div className="absolute inset-x-2 bottom-2 bg-brand-card-bg/95 backdrop-blur-md px-2.5 py-1 rounded-xl text-xs font-bold text-brand-plum truncate flex justify-between shadow-sm border border-brand-border/20">
                        <span>{photo.date}</span>
                        <ArrowRight className="w-2.5 h-2.5 text-brand-pink" />
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}
      </div>
    </div>
  );
}
