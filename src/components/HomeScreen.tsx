import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Plus, Flame, Shuffle, Lock, Settings, Calendar, ChevronRight, Sparkles, PenLine
} from 'lucide-react';
import { ResponsiveLayout, UserProfile } from '../types';
import SyncedImage from './SyncedImage';
import { useScreenPerformance } from '../hooks/useScreenPerformance';
import { diaryRepository } from '../repositories';
import type { HomeSummary } from '../repositories/DiaryRepository';

interface HomeScreenProps {
  userProfile: UserProfile;
  layout?: ResponsiveLayout;
  excludeDiaryIds?: string[];
  onNavigate: (tab: string, screen?: string, diaryId?: string, entryId?: string) => void;
  onOpenQuickNote: (noteText: string) => void;
  onOpenNewEntryWithPrompt: (promptText: string) => void;
}

const DEFAULT_PROMPTS = [
  "What made you smile unexpectedly today?",
  "Describe a small detail of nature you noticed today.",
  "Write down three things you are incredibly grateful for in this very moment.",
  "What is a soft, quiet memory that always brings you peace?",
  "If today had a color, what would it be and why?",
  "Who is someone who made you feel emotionally safe recently?",
  "What is one gentle lesson you are learning about yourself this week?"
];

export default function HomeScreen({ 
  userProfile,
  layout = 'mobile',
  excludeDiaryIds = [],
  onNavigate,
  onOpenQuickNote,
  onOpenNewEntryWithPrompt
}: HomeScreenProps) {
  useScreenPerformance('home');
  const [promptIndex, setPromptIndex] = useState<number>(0);
  const [quickThought, setQuickThought] = useState<string>('');
  const [activePrompt, setActivePrompt] = useState<string>(DEFAULT_PROMPTS[0]);
  const [greeting, setGreeting] = useState<string>('Good morning');
  const [summary, setSummary] = useState<HomeSummary | null>(null);
  const [summaryError, setSummaryError] = useState('');
  const excludeDiaryKey = excludeDiaryIds.join('|');

  const loadSummary = useCallback(async () => {
    try {
      const nextSummary = await diaryRepository.getHomeSummary({
        excludeDiaryIds: excludeDiaryKey ? excludeDiaryKey.split('|') : [],
      });
      setSummary(nextSummary);
      setSummaryError('');
    } catch (error: any) {
      setSummaryError(error?.message || 'Home summary could not be loaded.');
    }
  }, [excludeDiaryKey]);

  useEffect(() => {
    // Dynamic greeting based on current hour
    const hour = new Date().getHours();
    if (hour < 12) setGreeting('Good morning');
    else if (hour < 17) setGreeting('Good afternoon');
    else setGreeting('Good evening');
  }, []);

  useEffect(() => {
    void loadSummary();
    return diaryRepository.subscribeChanges((_revision, change) => {
      if (!change || [
        'entry-created',
        'entry-updated',
        'entry-deleted',
        'diary-created',
        'diary-updated',
        'diary-deleted',
        'note-created',
        'note-updated',
        'note-deleted',
        'profile-updated',
        'remote-batch-applied',
      ].includes(change.type)) {
        void loadSummary();
      }
    });
  }, [loadSummary]);

  const handleShufflePrompt = () => {
    let nextIndex = (promptIndex + 1) % DEFAULT_PROMPTS.length;
    setPromptIndex(nextIndex);
    setActivePrompt(DEFAULT_PROMPTS[nextIndex]);
  };

  const handleDiaryClick = (diary: HomeSummary['recentDiaries'][number]) => {
    onNavigate('diaries', 'diaryDetail', diary.id);
  };

  const handleQuickThoughtSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!quickThought.trim()) return;
    onOpenQuickNote(quickThought);
    setQuickThought('');
  };

  const profile = summary?.profile || userProfile;
  const todayWordCount = summary?.todayWordCount || 0;
  const streak = summary?.currentStreak || 0;
  const recentDiaries = summary?.recentDiaries || [];
  const recentEntries = summary?.recentEntries || [];
  const recentPhotos = summary?.recentPhotos || [];
  const freqTags = (summary?.commonTags || []).slice(0, 5).map(row => row.label || row.key);
  const goalPercent = Math.min(100, Math.round((todayWordCount / Math.max(1, profile.writingGoal)) * 100));
  const mostRecentEntry = recentEntries[0];
  const todayKey = new Date().toISOString().slice(0, 10);
  const continueLabel = mostRecentEntry?.date === todayKey ? 'Continue today\'s entry' : mostRecentEntry ? 'Continue writing' : 'Start today\'s entry';

  if (layout === 'desktop') {
    return (
      <div className="grid grid-cols-1 gap-7 2xl:grid-cols-[minmax(0,1fr)_300px]">
        <section className="min-w-0 space-y-7">
          <header className="flex flex-wrap items-start justify-between gap-5 xl:gap-6">
            <div>
              <p className="text-sm font-bold uppercase tracking-[0.22em] text-brand-sage">
                {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
              </p>
              <h1 className="mt-2 font-serif-diary text-4xl font-semibold tracking-tight text-brand-plum dark:text-brand-text xl:text-[3.25rem]">
                {greeting}, {profile.name || 'Writer'}
              </h1>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('stats', 'appSettings')}
              className="rounded-full border border-brand-border bg-white/70 px-5 py-2.5 text-sm font-bold text-brand-sage shadow-sm transition-all hover:bg-white"
            >
              Customize sanctuary
            </button>
          </header>

          {summaryError && (
            <p className="rounded-lg border border-yellow-200 bg-yellow-50 px-3 py-2 text-xs font-semibold text-yellow-800">
              {summaryError}
            </p>
          )}

          <section className="space-y-5">
            <div>
              <p className="text-sm font-bold uppercase tracking-[0.22em] text-brand-pink-dark">Prompt of the day</p>
              <h2 className="mt-3 max-w-4xl font-serif-diary text-4xl font-semibold leading-tight tracking-tight text-brand-plum dark:text-brand-text xl:text-[3rem]">
                {activePrompt}
              </h2>
            </div>

            <form onSubmit={handleQuickThoughtSubmit} className="rounded-[26px] border border-brand-border bg-white/82 p-5 shadow-[0_18px_55px_rgba(62,36,41,0.08)] dark:bg-brand-card-bg/82 xl:p-6">
              <textarea
                value={quickThought}
                onChange={(event) => setQuickThought(event.target.value)}
                placeholder="Start writing your quick jot..."
                className="min-h-[220px] w-full resize-none bg-transparent font-serif-diary text-2xl leading-relaxed text-brand-plum outline-none placeholder:text-brand-text-muted/35 dark:text-brand-text xl:min-h-[250px]"
              />
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-brand-border/60 pt-4">
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => onOpenNewEntryWithPrompt(activePrompt)}
                    className="inline-flex items-center gap-2 rounded-full bg-brand-sage px-5 py-3 text-sm font-bold text-white shadow-sm transition-all hover:bg-brand-sage-dark"
                  >
                    <PenLine className="h-4 w-4" />
                    Write full entry
                  </button>
                  <button
                    type="button"
                    onClick={handleShufflePrompt}
                    className="inline-flex items-center gap-2 rounded-full border border-brand-border bg-brand-bg/60 px-5 py-3 text-sm font-bold text-brand-sage transition-all hover:bg-brand-blush-light"
                  >
                    <Shuffle className="h-4 w-4" />
                    Shuffle prompt
                  </button>
                </div>
                <button
                  type="submit"
                  disabled={!quickThought.trim()}
                  className="rounded-full bg-brand-pink px-5 py-3 text-sm font-bold text-white shadow-sm transition-all hover:bg-brand-pink-dark disabled:cursor-not-allowed disabled:opacity-45"
                >
                  Save quick note
                </button>
              </div>
            </form>
          </section>

          <section className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_270px]">
            <div>
              <div className="mb-4 flex items-center justify-between">
                <h3 className="font-serif-diary text-2xl font-bold text-brand-plum dark:text-brand-text">Recent entries</h3>
                <button type="button" onClick={() => onNavigate('search')} className="text-sm font-bold text-brand-sage hover:text-brand-pink">
                  Browse all
                </button>
              </div>
              <div className="divide-y divide-brand-border overflow-hidden rounded-[24px] border border-brand-border bg-white/68 shadow-sm dark:bg-brand-card-bg/60">
                {recentEntries.length > 0 ? recentEntries.map(entry => (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => onNavigate('diaries', 'diaryDetail', entry.diaryId, entry.id)}
                    className="block w-full px-5 py-4 text-left transition-colors hover:bg-brand-blush-light/45"
                  >
                    <p className="text-sm font-bold text-brand-pink-dark">{new Date(entry.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', weekday: 'long' })}</p>
                    <h4 className="mt-1 font-serif-diary text-xl font-bold text-brand-plum dark:text-brand-text">{entry.title}</h4>
                    <p className="mt-1 line-clamp-1 text-sm text-brand-text-muted">
                      {entry.moodEmoji} {entry.moodName} &bull; {entry.wordCount} words
                    </p>
                  </button>
                )) : (
                  <div className="px-5 py-10 text-center text-sm font-semibold text-brand-text-muted">Your first fragment will appear after you save an entry.</div>
                )}
              </div>
            </div>

            <div>
              <div className="mb-4 flex items-center justify-between">
                <h3 className="font-serif-diary text-2xl font-bold text-brand-plum dark:text-brand-text">Journals</h3>
                <button type="button" onClick={() => onNavigate('diaries')} className="text-brand-sage hover:text-brand-pink" aria-label="View all journals">
                  <ChevronRight className="h-5 w-5" />
                </button>
              </div>
              <div className="space-y-3">
                {recentDiaries.map(diary => (
                  <button
                    key={diary.id}
                    type="button"
                    onClick={() => handleDiaryClick(diary)}
                    className="flex w-full items-center gap-3 rounded-2xl border border-brand-border bg-white/72 p-4 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:bg-white hover:shadow-[0_14px_34px_rgba(62,36,41,0.08)] dark:bg-brand-card-bg/65"
                  >
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-xl shadow-inner" style={{ backgroundColor: diary.color }}>
                      {diary.isLocked ? <Lock className="h-4 w-4 text-white" /> : diary.emoji}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate font-serif-diary text-lg font-bold text-brand-plum dark:text-brand-text">{diary.name}</span>
                      <span className="text-xs font-semibold text-brand-text-muted">{diary.entryCount} entries {' '}&bull;{' '}{diary.lastUpdated}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </section>
        </section>

        <aside className="grid gap-5 xl:grid-cols-2 2xl:sticky 2xl:top-6 2xl:block 2xl:self-start 2xl:space-y-5">
          <section className="rounded-[24px] border border-brand-border bg-white/76 p-5 shadow-[0_14px_40px_rgba(62,36,41,0.07)] dark:bg-brand-card-bg/70">
            <div className="flex items-center justify-between">
              <p className="text-sm font-bold uppercase tracking-[0.18em] text-brand-plum dark:text-brand-text">Your streak</p>
              <Flame className="h-5 w-5 text-brand-pink" />
            </div>
            <div className="mt-5 flex items-end gap-2">
              <span className="font-serif-diary text-5xl font-semibold text-brand-plum dark:text-brand-text">{streak}</span>
              <span className="pb-2 text-sm font-semibold text-brand-text-muted">days</span>
            </div>
          </section>

          <section className="rounded-[24px] border border-brand-border bg-white/60 p-5 shadow-sm dark:bg-brand-card-bg/60">
            <div className="flex items-center justify-between text-sm font-bold uppercase tracking-[0.16em] text-brand-plum dark:text-brand-text">
              <span>Daily goal</span>
              <span className="text-brand-text-muted normal-case tracking-normal">{todayWordCount} / {profile.writingGoal} words</span>
            </div>
            <div className="mt-4 h-2 rounded-full bg-brand-border/50">
              <div className="h-full rounded-full bg-brand-sage transition-all" style={{ width: `${goalPercent}%` }} />
            </div>
          </section>

          <section className="rounded-[24px] border border-brand-border bg-white/60 p-5 shadow-sm dark:bg-brand-card-bg/60">
            <h3 className="mb-4 text-sm font-bold uppercase tracking-[0.18em] text-brand-plum dark:text-brand-text">Recent memories</h3>
            <div className="grid grid-cols-2 gap-3">
              {recentPhotos.length > 0 ? recentPhotos.map(({ src, entryId, diaryId }, index) => (
                <button
                  key={`${entryId}-${index}`}
                  type="button"
                  aria-label={`Open photo memory ${index + 1}`}
                  onClick={() => onNavigate('diaries', 'diaryDetail', diaryId, entryId)}
                  className="aspect-square overflow-hidden rounded-xl border border-brand-border bg-white shadow-sm"
                >
                  <SyncedImage
                    src={src}
                    alt=""
                    className="h-full w-full object-cover transition-transform duration-500 hover:scale-105"
                    fallbackSrc="https://images.unsplash.com/photo-1517842645767-c639042777db?w=600"
                    label="recent memory"
                  />
                </button>
              )) : (
                <div className="col-span-2 rounded-2xl border border-dashed border-brand-border p-6 text-center text-xs font-semibold text-brand-text-muted">
                  Photo memories appear here.
                </div>
              )}
            </div>
          </section>

          <section className="rounded-[24px] border border-brand-border bg-white/60 p-5 shadow-sm dark:bg-brand-card-bg/60">
            <h3 className="mb-4 text-sm font-bold uppercase tracking-[0.18em] text-brand-plum dark:text-brand-text">Frequent tags</h3>
            <div className="flex flex-wrap gap-2">
              {freqTags.map(tag => (
                <span key={tag} className="rounded-full bg-brand-sage-light px-3 py-1.5 text-sm font-bold text-brand-sage-dark">
                  #{tag}
                </span>
              ))}
            </div>
          </section>

          <section className="rounded-[24px] border border-brand-border bg-white/68 p-5 shadow-sm dark:bg-brand-card-bg/55">
            <h3 className="font-serif-diary text-xl font-bold italic text-brand-plum dark:text-brand-text">Mindful Minute</h3>
            <p className="mt-2 text-sm leading-relaxed text-brand-text-muted">Close your eyes for three deep breaths before you start writing today.</p>
          </section>
        </aside>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 font-sans">
      
      {/* Top Header */}
      <header className="order-1 select-none pb-1 pt-2">
        <h2 className="font-serif-diary text-2xl font-semibold tracking-tight text-brand-plum dark:text-brand-text">
          {greeting}, {profile.name}
        </h2>
        <div className="mt-1 flex items-center gap-1.5 text-xs font-semibold text-brand-text-muted">
          <Calendar className="h-3.5 w-3.5 text-brand-sage" aria-hidden="true" />
          <span>{new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</span>
        </div>
      </header>

      <section className="surface-card order-2 flex items-center justify-between gap-4 p-5" aria-labelledby="continue-writing-title">
        <div className="min-w-0">
          <p className="app-eyebrow">Your writing</p>
          <h2 id="continue-writing-title" className="mt-1 truncate font-serif-diary text-2xl font-semibold text-brand-plum dark:text-brand-text">{continueLabel}</h2>
          <p className="mt-1 truncate text-sm text-brand-text-muted">{mostRecentEntry?.title || 'A quiet page is ready when you are.'}</p>
        </div>
        <button type="button" data-testid="home-continue-entry-button" aria-label={continueLabel} onClick={() => mostRecentEntry ? onNavigate('diaries', 'diaryDetail', mostRecentEntry.diaryId, mostRecentEntry.id) : onOpenNewEntryWithPrompt('')} className="flex min-h-11 shrink-0 items-center gap-2 rounded-xl bg-brand-sage px-4 text-sm font-bold text-white shadow-sm hover:bg-brand-sage-dark">
          <PenLine className="h-4 w-4" aria-hidden="true" /><span className="hidden sm:inline">Write</span>
        </button>
      </section>

      {summaryError && (
        <p className="order-2 rounded-lg border border-yellow-200 bg-yellow-50 px-3 py-2 text-sm font-semibold text-yellow-800">
          {summaryError}
        </p>
      )}

      {/* User Motto & Daily Writing Goal Progress */}
      <div className="order-5 rounded-2xl border border-brand-border bg-white/85 p-4 shadow-sm backdrop-blur-md dark:bg-brand-card-bg/85 dark:border-brand-border/20 flex flex-col gap-3 select-none">
        {profile.bio && (
          <div className="text-center italic text-brand-plum/90 dark:text-brand-text/90 text-sm font-serif-diary leading-relaxed px-2 border-b border-brand-border/30 dark:border-brand-border/10 pb-3">
            "{profile.bio}"
          </div>
        )}
        <div className="flex justify-between items-center text-xs">
          <div className="flex items-center gap-1.5 text-brand-plum dark:text-brand-text font-bold">
            <Flame className="w-4 h-4 text-brand-pink fill-brand-pink/20 animate-pulse" />
            <span>Daily Writing Goal</span>
          </div>
          <span className="font-mono text-[11px] text-brand-text-muted dark:text-brand-text font-bold bg-brand-bg dark:bg-brand-bg/50 px-2 py-0.5 rounded-lg border border-brand-border/50">
            {todayWordCount} / {profile.writingGoal} words
          </span>
        </div>
        <div className="flex items-center justify-between text-sm font-bold text-brand-plum dark:text-brand-text">
          <span className="flex items-center gap-2"><Flame className="h-4 w-4 text-brand-rose" aria-hidden="true" />{streak} day streak</span>
          <span className="text-xs text-brand-text-muted">Saved on this device</span>
        </div>
        <div className="relative w-full h-2.5 bg-brand-bg dark:bg-brand-bg/30 border border-brand-border/40 dark:border-brand-border/10 rounded-full overflow-hidden">
          <motion.div 
            className="absolute top-0 bottom-0 left-0 bg-gradient-to-r from-brand-pink to-brand-rose rounded-full"
            initial={{ width: 0 }}
            animate={{ width: `${goalPercent}%` }}
            transition={{ duration: 1.2, ease: "easeOut" }}
          />
        </div>
        <div className="flex justify-between items-center text-[10px] text-brand-text-muted dark:text-brand-text/60 font-semibold">
          <span>{todayWordCount >= profile.writingGoal ? "🎉 Goal completed for today!" : "Start writing to achieve your daily habit"}</span>
          <span className="text-brand-pink font-bold">
            {goalPercent}% Complete
          </span>
        </div>
      </div>

      {/* Writing Prompt Card (Vibe upgraded) */}
      <section aria-label="Daily writing prompt" className="order-3 w-full">
        <div className="bg-gradient-to-tr from-white via-white to-brand-blush-light dark:from-brand-card-bg dark:via-brand-card-bg dark:to-brand-blush-dark/15 rounded-[36px] p-7 md:p-8 shadow-xl relative overflow-hidden border border-brand-border/80 dark:border-brand-border/20 group">
          
          {/* Soft background decor spark */}
          <div className="absolute -top-10 -right-10 p-12 opacity-10 group-hover:scale-110 transition-transform duration-700">
            <Sparkles className="w-32 h-32 text-brand-pink" />
          </div>



          <AnimatePresence mode="wait">
            <motion.h2 
              key={activePrompt}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.3 }}
              className="text-xl md:text-2xl font-serif-diary font-medium leading-relaxed mb-6 text-brand-plum italic"
            >
              "{activePrompt}"
            </motion.h2>
          </AnimatePresence>

          <div className="flex flex-wrap items-center justify-between gap-4 border-t border-brand-border/40 dark:border-brand-border/10 pt-5 mt-2">
            <motion.button 
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              data-testid="home-write-entry-button"
              onClick={() => onOpenNewEntryWithPrompt(activePrompt)}
              className="bg-brand-pink text-white px-7 py-3.5 rounded-full font-bold text-xs flex items-center gap-2 shadow-lg shadow-brand-pink/15 hover:bg-brand-pink-dark transition-all"
            >
              <Plus className="w-4 h-4" />
              Write about this
            </motion.button>
            
            <button 
              onClick={handleShufflePrompt}
              className="text-brand-pink hover:text-brand-pink-dark text-[11px] font-bold uppercase tracking-wider flex items-center gap-2 transition-colors py-2 px-1 rounded-xl active:bg-brand-pink/5"
            >
              <Shuffle className="w-3.5 h-3.5" />
              <span>Refresh prompt</span>
            </button>
          </div>
        </div>
      </section>

      {/* Recent Diaries Section with 3D tactile covers */}
      <section aria-label="Recent Journals" className="order-4 flex flex-col gap-3.5">
        <div className="flex justify-between items-end">
          <div className="space-y-0.5">
            <h3 className="font-serif-diary text-xl font-semibold text-brand-plum leading-none">Recent journals</h3>
            <p className="text-[10px] text-brand-text-muted font-bold uppercase tracking-wider">Recently updated</p>
          </div>
          <button 
            onClick={() => onNavigate('diaries')}
            className="text-[11px] font-bold text-brand-pink hover:text-brand-pink-dark flex items-center gap-1 group py-1"
          >
            <span>View all journals</span>
            <ChevronRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" />
          </button>
        </div>

        {/* Horizontal Book Slider */}
        <div className="flex overflow-x-auto no-scrollbar gap-5 -mx-4 px-4 pb-2 select-none">
          {recentDiaries.map((diary) => {
            return (
              <motion.button
                type="button"
                key={diary.id}
                whileHover={{ y: -6 }}
                transition={{ type: "spring", stiffness: 300, damping: 20 }}
                onClick={() => handleDiaryClick(diary)}
                className="min-w-[140px] max-w-[140px] flex-shrink-0 cursor-pointer text-left group"
              >
                {/* 3D Physical Book Structure */}
                <div className="aspect-[3/4.2] relative mb-3.5 select-none">
                  {/* Double-layered realistic skeuomorphic shadow (shady effect) */}
                  <div className="absolute inset-y-1 left-2.5 right-1 bg-black/35 blur-[2px] rounded-r-xl pointer-events-none z-0 transition-all duration-300 group-hover:translate-x-1 group-hover:translate-y-1 group-hover:blur-[3px] group-hover:bg-black/40" />
                  <div className="absolute inset-y-3 left-4 right-0 bg-black/15 blur-lg rounded-r-xl pointer-events-none z-0 transition-all duration-300 group-hover:translate-x-2 group-hover:translate-y-2 group-hover:blur-xl group-hover:bg-black/20" />

                  {/* Tactile Satin Bookmark Ribbon peeking from the bottom */}
                  <div 
                    className="absolute bottom-[-10px] right-6 w-2.5 h-5 rounded-b shadow-[1px_2px_4px_rgba(0,0,0,0.3)] z-0 origin-top group-hover:scale-y-115 transition-all duration-300" 
                    style={{ backgroundColor: diary.color === '#8A3D55' ? '#DCA153' : '#8A3D55' }}
                  />

                  {/* Realistic Layered Pages peeking out from right and bottom */}
                  <div 
                    className="absolute top-[3px] bottom-[3px] right-[1px] left-3.5 bg-gradient-to-r from-[#d0c9b1] via-[#FAF8F3] to-[#F3EFE6] rounded-r border-y border-r border-black/10 z-0 shadow-[inset_1px_0_0_rgba(255,255,255,0.4)]"
                  />
                  <div 
                    className="absolute top-[5px] bottom-[5px] right-[3px] left-3.5 bg-gradient-to-r from-[#c0b89b] via-[#FFFDF9] to-[#FAF6EE] rounded-r border-y border-r border-black/5 z-0"
                    style={{
                      backgroundImage: 'repeating-linear-gradient(90deg, transparent, transparent 1px, rgba(0,0,0,0.03) 1px, rgba(0,0,0,0.03) 2px)'
                    }}
                  />

                  {/* Real Front Book Cover */}
                  <div 
                    className="absolute inset-y-0 left-0 right-2 rounded-r-[14px] rounded-l-[4px] shadow-[3px_3px_12px_rgba(0,0,0,0.25)] group-hover:shadow-[6px_8px_18px_rgba(0,0,0,0.32)] border-y border-r border-white/10 flex flex-col justify-between p-3 z-10 overflow-hidden transition-all duration-300"
                    style={{ 
                      backgroundColor: diary.color,
                      backgroundImage: diary.coverImage ? `url(${diary.coverImage})` : undefined,
                      backgroundSize: 'cover',
                      backgroundPosition: 'center'
                    }}
                  >
                    {/* Cover Gloss/Matte highlights */}
                    <div className="absolute inset-0 bg-gradient-to-tr from-black/25 via-white/[0.04] to-white/[0.15] pointer-events-none z-20" />
                    
                    {/* Hover Sheen sweep effect (high fidelity gloss shine) */}
                    <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/15 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-1000 ease-in-out pointer-events-none z-20" />
                    
                    {/* Realistic spine fold shading (hinge crease) with stronger skeuomorphic depth */}
                    <div className="absolute left-0 top-0 bottom-0 w-3.5 bg-gradient-to-r from-black/45 via-black/15 to-transparent pointer-events-none z-20" />
                    
                    {/* Page opening edge soft shadow to convey cover thickness */}
                    <div className="absolute right-0 top-0 bottom-0 w-2 bg-gradient-to-l from-black/20 to-transparent pointer-events-none z-20" />
                    <div className="absolute right-1 top-0 bottom-0 w-[1px] bg-white/10 pointer-events-none z-20" />
                    
                    {/* Vertical binding groove line */}
                    <div className="absolute left-[11px] top-0 bottom-0 w-[1px] bg-black/25 pointer-events-none z-20" />
                    <div className="absolute left-[12px] top-0 bottom-0 w-[1px] bg-white/10 pointer-events-none z-20" />

                    {/* Left spine horizontal raised bands (stitched book look) */}
                    <div className="absolute left-0 top-[20%] w-3 h-[2.5px] bg-black/20 border-b border-white/5 z-20 pointer-events-none shadow-[0_1px_0_rgba(0,0,0,0.1)]" />
                    <div className="absolute left-0 top-[40%] w-3 h-[2.5px] bg-black/20 border-b border-white/5 z-20 pointer-events-none shadow-[0_1px_0_rgba(0,0,0,0.1)]" />
                    <div className="absolute left-0 top-[60%] w-3 h-[2.5px] bg-black/20 border-b border-white/5 z-20 pointer-events-none shadow-[0_1px_0_rgba(0,0,0,0.1)]" />
                    <div className="absolute left-0 top-[80%] w-3 h-[2.5px] bg-black/20 border-b border-white/5 z-20 pointer-events-none shadow-[0_1px_0_rgba(0,0,0,0.1)]" />

                    {/* Golden vintage corner protectors */}
                    {!diary.coverImage && (
                      <>
                        <div className="absolute top-0 right-0 w-3 h-3 border-t border-r border-yellow-500/40 rounded-tr-lg pointer-events-none z-20" />
                        <div className="absolute bottom-0 right-0 w-3 h-3 border-b border-r border-yellow-500/40 rounded-br-lg pointer-events-none z-20" />
                      </>
                    )}

                    {/* Top Book Meta inside cover */}
                    <div className="flex justify-between items-start z-30 relative pl-1">
                      <div className="w-6.5 h-6.5 rounded-lg bg-white/95 dark:bg-brand-card-bg/95 flex items-center justify-center text-xs shadow-sm">
                        {diary.emoji}
                      </div>
                      {diary.isLocked && (
                        <span className="p-1 bg-black/20 backdrop-blur-sm rounded-md text-white">
                          <Lock className="w-2.5 h-2.5" />
                        </span>
                      )}
                    </div>

                    {/* Bottom Book Tag plaque (Centered classic look) */}
                    <div className="bg-white/95 dark:bg-brand-card-bg/95 p-2 rounded-lg shadow-md border border-brand-border/10 z-30 relative ml-1.5">
                      <p className="text-[9px] font-extrabold text-brand-plum truncate leading-none">
                        {diary.name}
                      </p>
                      <p className="text-[7.5px] font-bold text-brand-pink-dark uppercase tracking-wider mt-0.5">
                        {diary.entryCount} {diary.entryCount === 1 ? 'entry' : 'entries'}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="pl-1">
                  <h4 className="text-xs font-bold text-brand-plum truncate group-hover:text-brand-pink transition-colors">
                    {diary.name}
                  </h4>
                  <p className="text-[9px] text-brand-text-muted font-semibold mt-0.5">
                    Updated {diary.lastUpdated.toLowerCase()}
                  </p>
                </div>
              </motion.button>
            );
          })}
        </div>
      </section>

      {/* Lightweight quickcapture box */}
      <section aria-label="Capture a note" className="order-6 w-full">
        <div className="bg-white/90 dark:bg-brand-card-bg p-5 rounded-[28px] shadow-sm border border-brand-border/80 dark:border-brand-border/10 flex flex-col gap-3">
          <h3 className="text-xs font-extrabold text-brand-text-muted uppercase tracking-[0.18em]">Quick note</h3>
          <form onSubmit={handleQuickThoughtSubmit} className="flex gap-2">
            <input 
              type="text" 
              value={quickThought}
              onChange={(e) => setQuickThought(e.target.value)}
              placeholder="Capture a thought…"
              className="min-h-11 flex-grow bg-brand-bg/60 dark:bg-brand-bg/20 text-brand-plum placeholder-brand-plum/35 px-4.5 py-3 rounded-xl border border-brand-border/40 focus:outline-none focus:ring-2 focus:ring-brand-sage text-base font-medium transition-all"
            />
            <motion.button 
              whileTap={{ scale: 0.95 }}
              type="submit"
              disabled={!quickThought.trim()}
              className="bg-brand-pink disabled:opacity-40 disabled:cursor-not-allowed text-white px-5 rounded-2xl text-xs font-bold hover:bg-brand-pink-dark transition-all shadow-sm"
            >
              Add Note
            </motion.button>
          </form>
        </div>
      </section>

      {/* Active Streak Achievement Card */}
      <section className="hidden">
        
        {/* Glowing atmospheric bubble overlay */}
        <div className="absolute -right-12 -bottom-12 w-44 h-44 bg-white/10 rounded-full blur-3xl group-hover:scale-110 transition-transform duration-700 pointer-events-none" />
        <div className="absolute -left-12 -top-12 w-32 h-32 bg-brand-pink-dark/15 rounded-full blur-2xl pointer-events-none" />

        <div className="flex justify-between items-start mb-4 relative z-10">
          <span className="text-[9px] font-bold uppercase tracking-[0.25em] text-white/90 bg-white/15 px-3 py-1 rounded-full backdrop-blur-sm">Active Streak</span>
          <div className="relative">
            <Flame className="w-6 h-6 text-white animate-pulse" />
          </div>
        </div>
        
        <div className="flex items-baseline gap-2 relative z-10">
          <span className="text-6xl font-serif-diary font-bold italic tracking-tighter">{streak}</span>
          <span className="text-base font-bold uppercase tracking-wider text-white/90">days of mindfulness</span>
        </div>
        
        <p className="text-xs mt-3 text-white/85 leading-relaxed max-w-sm relative z-10 font-medium">
           {profile.name || 'Writer'}, you're doing incredibly well. Taking quiet moments daily to reflect forms emotional resilience. Keep it up!
        </p>
      </section>

      {/* Popular Tags */}
      <section aria-label="Frequently used tags" className="hidden">
        <h3 className="font-serif-diary text-lg font-bold text-brand-plum italic">Popular Topics</h3>
        <div className="flex flex-wrap gap-2.5 bg-white/90 dark:bg-brand-card-bg p-5 rounded-[32px] border border-brand-border/80 dark:border-brand-border/10 shadow-sm select-none">
          {freqTags.map(tag => (
            <motion.button 
              key={tag}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={() => onNavigate('search')}
              className="px-4 py-2 bg-brand-blush-light dark:bg-brand-blush-light/10 rounded-full text-xs font-bold text-brand-pink hover:bg-brand-pink hover:text-white dark:hover:text-black transition-all border border-brand-pink/5"
            >
              #{tag}
            </motion.button>
          ))}
          {freqTags.length === 0 && (
            <p className="text-xs text-brand-plum/50 italic py-1">No tags logged yet. Write entries to build topical insights.</p>
          )}
        </div>
      </section>

      {/* Navigation Shortcut */}
      <div className="hidden">
        <button 
          onClick={() => onNavigate('stats', 'appSettings')}
          className="inline-flex items-center gap-2 text-xs text-brand-pink hover:text-brand-pink-dark font-bold py-2 hover:underline transition-all"
        >
          <Settings className="w-3.5 h-3.5" />
          <span>Go to App Locking & Settings</span>
        </button>
      </div>
    </div>
  );
}
