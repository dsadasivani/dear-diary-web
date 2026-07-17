import React, { useCallback, useEffect, useState } from 'react';
import { Calendar, ChevronRight, Flame, PenLine, Plus, Shuffle } from 'lucide-react';
import type { ResponsiveLayout, UserProfile } from '../types';
import { useScreenPerformance } from '../hooks/useScreenPerformance';
import { diaryRepository } from '../repositories';
import type { HomeSummary } from '../repositories/DiaryRepository';
import JournalCover from './JournalCover';
import { StatusNotice } from './UiPrimitives';

interface HomeScreenProps {
  userProfile: UserProfile;
  layout?: ResponsiveLayout;
  excludeDiaryIds?: string[];
  onNavigate: (tab: string, screen?: string, diaryId?: string, entryId?: string) => void;
  onOpenQuickNote: (noteText: string) => void;
  onOpenNewEntryWithPrompt: (promptText: string) => void;
}

const DEFAULT_PROMPTS = [
  'What made you smile unexpectedly today?',
  'Describe a small detail of nature you noticed today.',
  'Write down three things you are grateful for in this moment.',
  'What is a quiet memory that always brings you peace?',
  'If today had a color, what would it be and why?',
  'Who made you feel emotionally safe recently?',
  'What gentle lesson are you learning about yourself this week?',
];

export default function HomeScreen({
  userProfile,
  layout = 'mobile',
  excludeDiaryIds = [],
  onNavigate,
  onOpenQuickNote,
  onOpenNewEntryWithPrompt,
}: HomeScreenProps) {
  useScreenPerformance('home');
  const [summary, setSummary] = useState<HomeSummary | null>(null);
  const [summaryError, setSummaryError] = useState('');
  const [quickThought, setQuickThought] = useState('');
  const [promptIndex, setPromptIndex] = useState(0);
  const excludeDiaryKey = excludeDiaryIds.join('|');

  const loadSummary = useCallback(async () => {
    try {
      setSummary(await diaryRepository.getHomeSummary({ excludeDiaryIds: excludeDiaryKey ? excludeDiaryKey.split('|') : [] }));
      setSummaryError('');
    } catch (error: any) {
      setSummaryError(error?.message || 'Today could not be loaded.');
    }
  }, [excludeDiaryKey]);

  useEffect(() => {
    void loadSummary();
    return diaryRepository.subscribeChanges((_revision, change) => {
      if (!change || /^(entry|diary|note|profile)-/.test(change.type) || change.type === 'remote-batch-applied') void loadSummary();
    });
  }, [loadSummary]);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const profile = summary?.profile || userProfile;
  const recentEntries = summary?.recentEntries || [];
  const recentDiaries = (summary?.recentDiaries || []).slice(0, 3);
  const mostRecentEntry = recentEntries[0];
  const todayKey = new Date().toISOString().slice(0, 10);
  const continueLabel = mostRecentEntry?.date === todayKey
    ? 'Continue today\'s entry'
    : mostRecentEntry ? 'Continue writing' : 'Start today\'s entry';
  const todayWordCount = summary?.todayWordCount || 0;
  const goal = Math.max(1, profile.writingGoal || 100);
  const goalPercent = Math.min(100, Math.round((todayWordCount / goal) * 100));
  const prompt = DEFAULT_PROMPTS[promptIndex];

  const openContinue = () => {
    if (mostRecentEntry) onNavigate('diaries', 'diaryDetail', mostRecentEntry.diaryId, mostRecentEntry.id);
    else onOpenNewEntryWithPrompt('');
  };

  const submitQuickNote = (event: React.FormEvent) => {
    event.preventDefault();
    const note = quickThought.trim();
    if (!note) return;
    onOpenQuickNote(note);
    setQuickThought('');
  };

  const ContinueCard = () => (
    <section className="surface-elevated p-5 md:p-6" aria-labelledby="continue-writing-title">
      <p className="app-eyebrow">Your writing</p>
      <div className="mt-2 flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h2 id="continue-writing-title" className="truncate font-serif-diary text-2xl font-semibold text-brand-plum dark:text-brand-text md:text-3xl">{continueLabel}</h2>
          <p className="mt-1 truncate text-sm text-brand-text-muted">{mostRecentEntry?.title || 'A quiet page is ready when you are.'}</p>
        </div>
        <button type="button" aria-label="Continue writing" data-testid="home-continue-entry-button" onClick={openContinue} className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-xl bg-brand-sage px-4 text-sm font-bold text-white hover:bg-brand-sage-dark">
          <PenLine className="h-4 w-4" aria-hidden="true" /><span className="hidden sm:inline">Write</span>
        </button>
      </div>
    </section>
  );

  const PromptCard = () => (
    <section className="surface-card p-5 md:p-6" aria-labelledby="daily-prompt-title">
      <p className="app-eyebrow">Daily prompt</p>
      <h2 id="daily-prompt-title" className="mt-3 font-serif-diary text-2xl font-medium leading-snug text-brand-plum dark:text-brand-text md:text-3xl">“{prompt}”</h2>
      <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-brand-border pt-4">
        <button type="button" data-testid="home-write-entry-button" onClick={() => onOpenNewEntryWithPrompt(prompt)} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-brand-pink px-4 text-sm font-bold text-white hover:bg-brand-pink-dark">
          <Plus className="h-4 w-4" />Write about this
        </button>
        <button type="button" onClick={() => setPromptIndex(index => (index + 1) % DEFAULT_PROMPTS.length)} className="inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm font-bold text-brand-sage hover:bg-brand-sage-light/60" aria-label="Refresh writing prompt">
          <Shuffle className="h-4 w-4" />Refresh
        </button>
      </div>
    </section>
  );

  const RecentEntries = () => (
    <section aria-labelledby="recent-entries-title">
      <div className="mb-3 flex items-center justify-between">
        <h2 id="recent-entries-title" className="font-serif-diary text-2xl font-semibold text-brand-plum dark:text-brand-text">Recent entries</h2>
        <button type="button" onClick={() => onNavigate('search')} className="text-sm font-bold text-brand-sage">Browse all</button>
      </div>
      <div className="surface-card divide-y divide-brand-border overflow-hidden">
        {recentEntries.slice(0, 5).map(entry => (
          <button key={entry.id} type="button" onClick={() => onNavigate('diaries', 'diaryDetail', entry.diaryId, entry.id)} className="block w-full px-4 py-4 text-left hover:bg-brand-sage-light/35">
            <p className="text-xs font-bold text-brand-text-muted">{new Date(entry.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', weekday: 'short' })}</p>
            <h3 className="mt-1 truncate font-serif-diary text-lg font-bold text-brand-plum dark:text-brand-text">{entry.title}</h3>
            <p className="mt-1 text-sm text-brand-text-muted">{entry.moodEmoji} {entry.moodName} · {entry.wordCount} words</p>
          </button>
        ))}
        {recentEntries.length === 0 && <p className="px-4 py-10 text-center text-sm text-brand-text-muted">Your recent entries will appear here.</p>}
      </div>
    </section>
  );

  const RecentJournals = () => (
    <section aria-labelledby="recent-journals-title">
      <div className="mb-3 flex items-center justify-between">
        <h2 id="recent-journals-title" className="font-serif-diary text-2xl font-semibold text-brand-plum dark:text-brand-text">Recent journals</h2>
        <button type="button" onClick={() => onNavigate('diaries')} className="icon-button" aria-label="View all journals"><ChevronRight className="h-5 w-5" /></button>
      </div>
      <div className="grid gap-2">
        {recentDiaries.map(diary => (
          <button key={diary.id} type="button" onClick={() => onNavigate('diaries', 'diaryDetail', diary.id)} className="surface-card flex min-h-16 w-full items-center gap-3 p-3 text-left hover:border-brand-sage">
            <JournalCover diary={diary} variant="thumbnail" showTitle={false} />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-serif-diary text-lg font-bold text-brand-plum dark:text-brand-text">{diary.name}</span>
              <span className="text-xs text-brand-text-muted">{diary.entryCount} entries · {diary.lastUpdated}</span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );

  const Progress = () => (
    <section className="surface-card p-4" aria-label="Writing progress">
      <div className="flex items-center justify-between gap-3 text-sm font-bold text-brand-plum dark:text-brand-text">
        <span className="flex items-center gap-2"><Flame className="h-4 w-4 text-brand-rose" />{summary?.currentStreak || 0} day streak</span>
        <span className="text-xs text-brand-text-muted">{todayWordCount} / {goal} words</span>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-brand-border/60" aria-label={`${goalPercent}% of today's word goal`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={goalPercent}>
        <div className="h-full rounded-full bg-brand-sage" style={{ width: `${goalPercent}%` }} />
      </div>
      <p className="mt-2 text-xs text-brand-text-muted">Saved securely on this device</p>
    </section>
  );

  const QuickCapture = () => (
    <form onSubmit={submitQuickNote} className="surface-card flex gap-2 p-3" aria-label="Capture a quick note">
      <input value={quickThought} onChange={event => setQuickThought(event.target.value)} placeholder="Capture a thought…" className="min-h-11 min-w-0 flex-1 rounded-xl border border-brand-border bg-brand-bg/50 px-4 text-base text-brand-plum outline-none focus:border-brand-sage dark:text-brand-text" />
      <button type="submit" disabled={!quickThought.trim()} className="min-h-11 rounded-xl bg-brand-pink px-4 text-sm font-bold text-white disabled:opacity-40">Add</button>
    </form>
  );

  return (
    <div className="space-y-6 pb-4">
      <header>
        <p className="flex items-center gap-2 text-sm font-semibold text-brand-text-muted"><Calendar className="h-4 w-4" />{new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</p>
        <h1 className="mt-1 font-serif-diary text-3xl font-semibold text-brand-plum dark:text-brand-text md:text-4xl">{greeting}, {profile.name || 'Writer'}</h1>
      </header>
      {summaryError && <StatusNotice tone="warning" role="alert">{summaryError}</StatusNotice>}
      {layout === 'desktop' ? (
        <div className="grid gap-7 2xl:grid-cols-[minmax(0,7fr)_minmax(260px,3fr)]">
          <main className="space-y-7"><ContinueCard /><PromptCard /><RecentEntries /></main>
          <aside className="space-y-5"><Progress /><RecentJournals /><QuickCapture /></aside>
        </div>
      ) : (
        <main className="space-y-6"><ContinueCard /><PromptCard /><RecentJournals /><Progress /><QuickCapture /></main>
      )}
    </div>
  );
}
