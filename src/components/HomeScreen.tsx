import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ArrowUpRight, Calendar, ChevronRight, Flame, PenLine, Plus, Shuffle } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import type { ResponsiveLayout, UserProfile } from '../types';
import { useScreenPerformance } from '../hooks/useScreenPerformance';
import { diaryRepository } from '../repositories';
import type { HomeSummary } from '../repositories/DiaryRepository';
import JournalCover from './JournalCover';
import {
  AppButton,
  PaperSurface,
  ProgressIndicator,
  SectionHeader,
  StatusNotice,
} from './UiPrimitives';
import { useAmbientTheme } from '../design/ambientTheme';
import { toLocalDateKey } from '../utils/localDate';
import { motionTransitions } from './ui/motion';

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

let hasPlayedHomeReveal = false;

export default function HomeScreen({
  userProfile,
  layout = 'mobile',
  excludeDiaryIds = [],
  onNavigate,
  onOpenQuickNote,
  onOpenNewEntryWithPrompt,
}: HomeScreenProps) {
  useScreenPerformance('home');
  const reducedMotion = useReducedMotion();
  const { setAmbientContext, resetAmbientContext } = useAmbientTheme();
  const [playLaunchReveal] = useState(() => !hasPlayedHomeReveal);
  const [summary, setSummary] = useState<HomeSummary | null>(null);
  const [summaryError, setSummaryError] = useState('');
  const [quickThought, setQuickThought] = useState('');
  const [promptIndex, setPromptIndex] = useState(0);
  const excludeDiaryKey = excludeDiaryIds.join('|');

  useEffect(() => {
    hasPlayedHomeReveal = true;
  }, []);

  useEffect(() => {
    setAmbientContext({
      mood: summary?.recentEntries[0]?.moodName || 'neutral',
      journalColor: summary?.recentDiaries[0]?.color || null,
    });
    return resetAmbientContext;
  }, [resetAmbientContext, setAmbientContext, summary]);

  const loadSummary = useCallback(async () => {
    try {
      setSummary(
        await diaryRepository.getHomeSummary({
          excludeDiaryIds: excludeDiaryKey ? excludeDiaryKey.split('|') : [],
        }),
      );
      setSummaryError('');
    } catch (error: any) {
      setSummaryError(error?.message || 'Today could not be loaded.');
    }
  }, [excludeDiaryKey]);

  useEffect(() => {
    void loadSummary();
    return diaryRepository.subscribeChanges((_revision, change) => {
      if (
        !change ||
        /^(entry|diary|note|profile)-/.test(change.type) ||
        change.type === 'remote-batch-applied'
      )
        void loadSummary();
    });
  }, [loadSummary]);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const profile = summary?.profile || userProfile;
  const recentEntries = summary?.recentEntries || [];
  const recentDiaries = (summary?.recentDiaries || []).slice(0, layout === 'desktop' ? 4 : 3);
  const mostRecentEntry = recentEntries[0];
  const todayKey = toLocalDateKey();
  const continueLabel =
    mostRecentEntry?.date === todayKey
      ? 'Continue today’s entry'
      : mostRecentEntry
        ? 'Return to your last page'
        : 'Begin today’s page';
  const todayWordCount = summary?.todayWordCount || 0;
  const goal = Math.max(1, profile.writingGoal || 100);
  const prompt = DEFAULT_PROMPTS[promptIndex];

  const openContinue = () => {
    if (mostRecentEntry)
      onNavigate('diaries', 'diaryDetail', mostRecentEntry.diaryId, mostRecentEntry.id);
    else onOpenNewEntryWithPrompt('');
  };

  const submitQuickNote = (event: FormEvent) => {
    event.preventDefault();
    const note = quickThought.trim();
    if (!note) return;
    onOpenQuickNote(note);
    setQuickThought('');
  };

  const ContinueSpace = () => (
    <motion.div
      initial={playLaunchReveal && !reducedMotion ? { opacity: 0, y: 12 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={motionTransitions.page}
    >
      <PaperSurface
        className="living-memory-hero relative overflow-hidden p-5 md:p-8"
        aria-labelledby="continue-writing-title"
      >
        <p className="app-eyebrow hidden sm:block">Your open page</p>
        <div className="mt-0 flex items-end justify-between gap-5 sm:mt-3">
          <div className="min-w-0">
            <h2 id="continue-writing-title" className="type-section-title truncate md:text-3xl">
              {layout === 'mobile'
                ? mostRecentEntry
                  ? 'Continue writing'
                  : 'Start writing'
                : continueLabel}
            </h2>
            <p className="type-supporting mt-1 truncate">
              {mostRecentEntry?.title || 'A quiet page is ready when you are.'}
            </p>
          </div>
          <button
            type="button"
            aria-label="Continue writing"
            data-testid="home-continue-entry-button"
            onClick={openContinue}
            className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full bg-accent px-4 text-sm font-bold text-[var(--color-on-primary)] shadow-[var(--shadow-soft)] transition-transform active:scale-[0.98] hover:bg-accent-strong"
          >
            <PenLine className="h-4 w-4" aria-hidden="true" />
            <span className="hidden sm:inline">Write</span>
          </button>
        </div>
      </PaperSurface>
    </motion.div>
  );

  const PromptPaper = () => (
    <section
      className="relative overflow-hidden border-y border-[var(--border-subtle)] bg-paper-muted/65 px-4 py-7 md:px-7 md:py-9"
      aria-labelledby="daily-prompt-title"
    >
      <span
        className="absolute -right-8 -top-10 font-serif-diary text-[9rem] leading-none text-accent/7"
        aria-hidden="true"
      >
        “
      </span>
      <p className="app-eyebrow hidden sm:block">A question for today</p>
      <h2
        id="daily-prompt-title"
        className="relative mt-0 max-w-3xl font-serif-diary text-[clamp(1.65rem,4vw,2.55rem)] font-medium leading-[1.12] tracking-[-0.02em] text-ink sm:mt-4"
      >
        {prompt}
      </h2>
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <AppButton
          tone="primary"
          data-testid="home-write-entry-button"
          onClick={() => onOpenNewEntryWithPrompt(prompt)}
        >
          <Plus className="h-4 w-4" />
          {layout === 'mobile' ? 'Write' : 'Write from this'}
        </AppButton>
        <AppButton
          tone="quiet"
          onClick={() => setPromptIndex((index) => (index + 1) % DEFAULT_PROMPTS.length)}
        >
          <Shuffle className="h-4 w-4" />
          {layout === 'mobile' ? 'New prompt' : 'Another prompt'}
        </AppButton>
      </div>
    </section>
  );

  const RecentEntries = () => (
    <section aria-label="Recent pages">
      <SectionHeader
        title="Recent pages"
        action={
          <button
            type="button"
            onClick={() => onNavigate('search')}
            className="inline-flex min-h-11 items-center gap-1 text-sm font-bold text-accent"
          >
            Browse memories
            <ArrowUpRight className="h-4 w-4" />
          </button>
        }
        className="mb-2"
      />
      <div className="divide-y divide-[var(--border-subtle)] border-y border-[var(--border-subtle)]">
        {recentEntries.slice(0, layout === 'desktop' ? 5 : 3).map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => onNavigate('diaries', 'diaryDetail', entry.diaryId, entry.id)}
            className="group grid w-full grid-cols-[4.25rem_minmax(0,1fr)_auto] items-center gap-3 py-4 text-left"
          >
            <span className="type-metadata border-r border-[var(--border-subtle)] pr-3 text-right">
              {new Date(entry.date).toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
              })}
            </span>
            <span className="min-w-0">
              <span className="block truncate font-serif-diary text-lg font-semibold text-ink group-hover:text-accent-strong">
                {entry.title}
              </span>
              <span className="type-metadata mt-1 block">
                {entry.moodEmoji} {entry.moodName}
                {layout !== 'mobile' && ` · ${entry.wordCount} words`}
              </span>
            </span>
            <ChevronRight className="h-4 w-4 text-ink-tertiary" aria-hidden="true" />
          </button>
        ))}
        {recentEntries.length === 0 && (
          <p className="py-10 text-center text-sm text-ink-secondary">
            Your recent pages will gather here.
          </p>
        )}
      </div>
    </section>
  );

  const RecentJournals = () => (
    <section aria-label="Recent journals">
      <SectionHeader
        title="Recent journals"
        action={
          <button
            type="button"
            onClick={() => onNavigate('diaries')}
            className="icon-button"
            aria-label="View all journals"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        }
        className="mb-4"
      />
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-2 2xl:grid-cols-3">
        {recentDiaries.map((diary) => (
          <motion.button
            key={diary.id}
            type="button"
            onClick={() => onNavigate('diaries', 'diaryDetail', diary.id)}
            initial={playLaunchReveal && !reducedMotion ? { opacity: 0, scale: 0.96, y: 8 } : false}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={{
              ...motionTransitions.page,
              delay: Math.min(0.16, recentDiaries.indexOf(diary) * 0.045),
            }}
            whileTap={reducedMotion ? undefined : { scale: 0.98 }}
            className="group min-w-0 text-left"
          >
            <JournalCover diary={diary} variant="full" className="w-full" showTitle={false} />
            <span className="min-w-0 flex-1 border-b border-[var(--border-subtle)] py-3">
              <span className="block truncate font-serif-diary text-lg font-semibold text-ink group-hover:text-accent-strong">
                {diary.name}
              </span>
              <span className="type-metadata mt-0.5 block">
                {diary.entryCount} entries · {diary.lastUpdated}
              </span>
            </span>
          </motion.button>
        ))}
        {recentDiaries.length === 0 && (
          <p className="type-supporting py-5">Create a journal to give your writing a home.</p>
        )}
      </div>
    </section>
  );

  const Progress = () => (
    <section className="border-y border-[var(--border-subtle)] py-4" aria-label="Writing progress">
      <div className="mb-4 flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-sm font-bold text-ink">
          <Flame className="h-4 w-4 text-[var(--accent-warm)]" />
          {summary?.currentStreak || 0} day streak
        </span>
        <span className="type-metadata hidden sm:inline">Saved privately on this device</span>
      </div>
      <ProgressIndicator
        value={todayWordCount}
        max={goal}
        label={`${todayWordCount} of ${goal} words today`}
      />
    </section>
  );

  const QuickCapture = () => (
    <form
      onSubmit={submitQuickNote}
      className="surface-glass flex gap-2 rounded-[var(--radius-modal)] p-2.5"
      aria-label="Capture a quick note"
    >
      <label className="sr-only" htmlFor="home-quick-thought">
        Capture a thought
      </label>
      <input
        id="home-quick-thought"
        value={quickThought}
        onChange={(event) => setQuickThought(event.target.value)}
        placeholder="A thought before it passes…"
        className="min-h-11 min-w-0 flex-1 border-0 bg-transparent px-3 text-base text-ink outline-none placeholder:text-ink-tertiary"
      />
      <button
        type="submit"
        disabled={!quickThought.trim()}
        className="min-h-11 rounded-full bg-[var(--accent-secondary)] px-4 text-sm font-bold text-[var(--color-on-secondary)] disabled:opacity-40"
      >
        Keep
      </button>
    </form>
  );

  return (
    <div className="space-y-7 pb-4">
      <motion.header
        initial={playLaunchReveal && !reducedMotion ? { opacity: 0, y: 10 } : false}
        animate={{ opacity: 1, y: 0 }}
        transition={motionTransitions.page}
      >
        <p className="flex items-center gap-2 text-sm font-semibold text-ink-secondary">
          <Calendar className="h-4 w-4" />
          {new Date().toLocaleDateString(undefined, {
            weekday: 'long',
            month: 'long',
            day: 'numeric',
          })}
        </p>
        <h1 className="mt-1 font-serif-diary text-[clamp(2rem,5vw,3.5rem)] font-semibold leading-none tracking-[-0.025em] text-ink">
          {greeting}
          {layout !== 'mobile' && `, ${profile.name || 'Writer'}`}
        </h1>
      </motion.header>
      {summaryError && (
        <StatusNotice tone="warning" role="alert">
          {summaryError}
        </StatusNotice>
      )}
      {layout === 'desktop' ? (
        <div className="grid gap-9 2xl:grid-cols-[minmax(0,7fr)_minmax(280px,3fr)]">
          <main className="space-y-9">
            <ContinueSpace />
            <PromptPaper />
            <RecentEntries />
          </main>
          <aside className="space-y-7">
            <Progress />
            <RecentJournals />
            <QuickCapture />
          </aside>
        </div>
      ) : (
        <main className="space-y-8">
          <ContinueSpace />
          <PromptPaper />
          <RecentEntries />
          <RecentJournals />
          <Progress />
          <QuickCapture />
        </main>
      )}
    </div>
  );
}
