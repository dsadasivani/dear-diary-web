import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  BookOpen, Plus, Flame, Shuffle, 
  Lock, Settings, ArrowRight, MessageSquareCode, 
  Smile, ShieldAlert, Fingerprint, Calendar, ChevronRight, Sparkles
} from 'lucide-react';
import { Diary, Entry, Note, UserProfile } from '../types';
import { PREDEFINED_TAGS, calculateStreak, getTodayWordCount } from '../utils/storage';

interface HomeScreenProps {
  diaries: Diary[];
  entries: Entry[];
  notes: Note[];
  userProfile: UserProfile;
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
  diaries, 
  entries, 
  notes, 
  userProfile,
  onNavigate,
  onOpenQuickNote,
  onOpenNewEntryWithPrompt
}: HomeScreenProps) {
  const [promptIndex, setPromptIndex] = useState<number>(0);
  const [quickThought, setQuickThought] = useState<string>('');
  const [streak, setStreak] = useState<number>(0);
  const [activePrompt, setActivePrompt] = useState<string>(DEFAULT_PROMPTS[0]);
  const [greeting, setGreeting] = useState<string>('Good morning');
  
  // Passcode verification for locked diaries
  const [verifyDiary, setVerifyDiary] = useState<Diary | null>(null);
  const [biometricUnlockSuccess, setBiometricUnlockSuccess] = useState<boolean>(false);

  const todayWordCount = getTodayWordCount(entries);

  useEffect(() => {
    // Dynamic greeting based on current hour
    const hour = new Date().getHours();
    if (hour < 12) setGreeting('Good morning');
    else if (hour < 17) setGreeting('Good afternoon');
    else setGreeting('Good evening');

    // Calculate real streak from entries
    const calculated = calculateStreak(entries);
    setStreak(calculated);
  }, [entries]);

  const handleShufflePrompt = () => {
    let nextIndex = (promptIndex + 1) % DEFAULT_PROMPTS.length;
    setPromptIndex(nextIndex);
    setActivePrompt(DEFAULT_PROMPTS[nextIndex]);
  };

  const handleDiaryClick = (diary: Diary) => {
    if (diary.isLocked) {
      setVerifyDiary(diary);
      setBiometricUnlockSuccess(false);
    } else {
      onNavigate('diaries', 'diaryDetail', diary.id);
    }
  };

  const handleBiometricSimulate = () => {
    setBiometricUnlockSuccess(true);
    setTimeout(() => {
      if (verifyDiary) {
        onNavigate('diaries', 'diaryDetail', verifyDiary.id);
        setVerifyDiary(null);
      }
    }, 800);
  };

  const handleQuickThoughtSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!quickThought.trim()) return;
    onOpenQuickNote(quickThought);
    setQuickThought('');
  };

  // Get most active tags from entries and notes
  const getFrequentlyUsedTags = () => {
    const counts: { [key: string]: number } = {};
    PREDEFINED_TAGS.forEach(t => { counts[t] = 0; });
    
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

    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(entry => entry[0]);
  };

  const recentDiaries = [...diaries]
    .sort((a, b) => {
      if (a.lastUpdated === 'Today') return -1;
      if (b.lastUpdated === 'Today') return 1;
      return b.entryCount - a.entryCount;
    })
    .slice(0, 4);

  const freqTags = getFrequentlyUsedTags();

  return (
    <div className="flex flex-col gap-6 font-sans">
      
      {/* Top Header */}
      <header className="flex justify-between items-center bg-transparent sticky top-0 py-4 z-30 select-none">
        <div className="flex items-center gap-3.5">
          <div className="relative group">
            <div className="absolute inset-0 bg-brand-pink/20 rounded-full blur-md group-hover:bg-brand-pink/30 transition-all" />
            <button 
              onClick={() => onNavigate('stats', 'appSettings')}
              className="w-13 h-13 rounded-full bg-white dark:bg-brand-card-bg flex items-center justify-center text-2xl border-2 border-brand-border shadow-md z-10 relative hover:scale-105 transition-transform"
              style={{ backgroundColor: userProfile.avatarColor }}
              title="Edit Profile"
            >
              <span>{userProfile.avatarEmoji}</span>
            </button>
          </div>
          <div>
            <h1 className="text-2xl font-serif-diary font-bold italic tracking-tight text-brand-plum leading-tight dark:text-brand-text">
              {greeting}, {userProfile.name}
            </h1>
            <div className="flex items-center gap-1.5 opacity-65 font-medium text-[11px] text-brand-plum dark:text-brand-text mt-0.5 uppercase tracking-wider">
              <Calendar className="w-3 h-3 text-brand-pink" />
              <span>
                {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}
              </span>
            </div>
          </div>
        </div>
        
        <button 
          onClick={() => onNavigate('stats', 'appSettings')}
          className="w-11 h-11 rounded-2xl bg-white/85 dark:bg-brand-card-bg/85 backdrop-blur-md flex items-center justify-center shadow-sm text-brand-plum dark:text-brand-text opacity-85 hover:opacity-100 border border-brand-border/85 hover:border-brand-pink/30 transition-all hover:scale-105 active:scale-95"
          title="Security & System Settings"
        >
          <Settings className="w-4.5 h-4.5" />
        </button>
      </header>

      {/* User Motto & Daily Writing Goal Progress */}
      <div className="bg-white/85 dark:bg-brand-card-bg/85 backdrop-blur-md p-5 rounded-[32px] border border-brand-border/60 dark:border-brand-border/20 shadow-md flex flex-col gap-3 select-none">
        {userProfile.bio && (
          <div className="text-center italic text-brand-plum/90 dark:text-brand-text/90 text-sm font-serif-diary leading-relaxed px-2 border-b border-brand-border/30 dark:border-brand-border/10 pb-3">
            "{userProfile.bio}"
          </div>
        )}
        <div className="flex justify-between items-center text-xs">
          <div className="flex items-center gap-1.5 text-brand-plum dark:text-brand-text font-bold">
            <Flame className="w-4 h-4 text-brand-pink fill-brand-pink/20 animate-pulse" />
            <span>Daily Writing Goal</span>
          </div>
          <span className="font-mono text-[11px] text-brand-text-muted dark:text-brand-text font-bold bg-brand-bg dark:bg-brand-bg/50 px-2 py-0.5 rounded-lg border border-brand-border/50">
            {todayWordCount} / {userProfile.writingGoal} words
          </span>
        </div>
        <div className="relative w-full h-2.5 bg-brand-bg dark:bg-brand-bg/30 border border-brand-border/40 dark:border-brand-border/10 rounded-full overflow-hidden">
          <motion.div 
            className="absolute top-0 bottom-0 left-0 bg-gradient-to-r from-brand-pink to-brand-rose rounded-full"
            initial={{ width: 0 }}
            animate={{ width: `${Math.min(100, (todayWordCount / userProfile.writingGoal) * 100)}%` }}
            transition={{ duration: 1.2, ease: "easeOut" }}
          />
        </div>
        <div className="flex justify-between items-center text-[10px] text-brand-text-muted dark:text-brand-text/60 font-semibold">
          <span>{todayWordCount >= userProfile.writingGoal ? "🎉 Goal completed for today!" : "Start writing to achieve your daily habit"}</span>
          <span className="text-brand-pink font-bold">
            {Math.min(100, Math.round((todayWordCount / userProfile.writingGoal) * 100))}% Complete
          </span>
        </div>
      </div>

      {/* Writing Prompt Card (Vibe upgraded) */}
      <section aria-label="Daily writing prompt" className="w-full">
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
              onClick={() => onOpenNewEntryWithPrompt(activePrompt)}
              className="bg-brand-pink text-white px-7 py-3.5 rounded-full font-bold text-xs flex items-center gap-2 shadow-lg shadow-brand-pink/15 hover:bg-brand-pink-dark transition-all"
            >
              <Plus className="w-4 h-4" />
              Write reflections
            </motion.button>
            
            <button 
              onClick={handleShufflePrompt}
              className="text-brand-pink hover:text-brand-pink-dark text-[11px] font-bold uppercase tracking-wider flex items-center gap-2 transition-colors py-2 px-1 rounded-xl active:bg-brand-pink/5"
            >
              <Shuffle className="w-3.5 h-3.5" />
              <span>Shuffle prompt</span>
            </button>
          </div>
        </div>
      </section>

      {/* Recent Diaries Section with 3D tactile covers */}
      <section aria-label="Recent Diaries" className="flex flex-col gap-3.5">
        <div className="flex justify-between items-end">
          <div className="space-y-0.5">
            <h3 className="font-serif-diary text-lg font-bold text-brand-plum italic leading-none">Your Journals</h3>
            <p className="text-[10px] text-brand-text-muted font-bold uppercase tracking-wider opacity-85">Recently Updated</p>
          </div>
          <button 
            onClick={() => onNavigate('diaries')}
            className="text-[11px] font-bold text-brand-pink hover:text-brand-pink-dark flex items-center gap-1 group py-1"
          >
            <span>View all books</span>
            <ChevronRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" />
          </button>
        </div>

        {/* Horizontal Book Slider */}
        <div className="flex overflow-x-auto no-scrollbar gap-5 -mx-4 px-4 pb-2 select-none">
          {recentDiaries.map((diary, index) => {
            return (
              <motion.div 
                key={diary.id}
                whileHover={{ y: -6 }}
                transition={{ type: "spring", stiffness: 300, damping: 20 }}
                onClick={() => handleDiaryClick(diary)}
                className="min-w-[140px] max-w-[140px] flex-shrink-0 cursor-pointer group"
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
              </motion.div>
            );
          })}
        </div>
      </section>

      {/* Lightweight quickcapture box */}
      <section aria-label="Capture a thought" className="w-full">
        <div className="bg-white/90 dark:bg-brand-card-bg p-5 rounded-[28px] shadow-sm border border-brand-border/80 dark:border-brand-border/10 flex flex-col gap-3">
          <h3 className="text-[10px] font-extrabold text-brand-text-muted uppercase tracking-[0.25em]">Quick Jot</h3>
          <form onSubmit={handleQuickThoughtSubmit} className="flex gap-2">
            <input 
              type="text" 
              value={quickThought}
              onChange={(e) => setQuickThought(e.target.value)}
              placeholder="Jot down a lightweight reflection..."
              className="flex-grow bg-brand-bg/60 dark:bg-brand-bg/20 text-brand-plum placeholder-brand-plum/35 px-4.5 py-3 rounded-2xl border border-brand-border/40 focus:outline-none focus:ring-2 focus:ring-brand-pink text-xs font-medium transition-all"
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
      <section className="bg-gradient-to-br from-brand-pink to-brand-sage dark:from-brand-pink-dark dark:to-brand-blush-dark rounded-[36px] p-6.5 text-white shadow-xl relative overflow-hidden select-none group">
        
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
           {userProfile.name}, you're doing incredibly well. Taking quiet moments daily to reflect forms emotional resilience. Keep it up!
        </p>
      </section>

      {/* Popular Tags */}
      <section aria-label="Frequently used tags" className="flex flex-col gap-3">
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
      <div className="pt-2 text-center">
        <button 
          onClick={() => onNavigate('stats', 'appSettings')}
          className="inline-flex items-center gap-2 text-xs text-brand-pink hover:text-brand-pink-dark font-bold py-2 hover:underline transition-all"
        >
          <Settings className="w-3.5 h-3.5" />
          <span>Go to App Locking & Settings</span>
        </button>
      </div>

      {/* Biometric Challenge Overlay Modal */}
      <AnimatePresence>
        {verifyDiary && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-md">
            <motion.div 
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="w-full max-w-sm bg-brand-card-bg rounded-[32px] p-6.5 shadow-2xl border border-brand-border flex flex-col gap-4 text-center items-center relative overflow-hidden"
            >
              {/* Decorative radial blur inside modal */}
              <div className="absolute top-[-20%] left-[-20%] w-[60%] h-[60%] rounded-full bg-brand-pink/10 blur-xl pointer-events-none" />

              <div className="w-13 h-13 rounded-2xl bg-brand-pink/10 flex items-center justify-center text-brand-pink animate-pulse relative z-10">
                <Lock className="w-5 h-5" />
              </div>
              
              <div className="relative z-10 space-y-1">
                <h3 className="font-serif-diary text-lg font-bold text-brand-plum">Journal Secured</h3>
                <p className="text-xs text-brand-text-muted px-2">
                  "{verifyDiary.name}" is passcode locked. Tap fingerprint or use PIN configuration.
                </p>
              </div>

              {biometricUnlockSuccess ? (
                <div className="py-6 flex flex-col items-center gap-2 relative z-10">
                  <div className="w-11 h-11 rounded-full bg-brand-pink/10 flex items-center justify-center text-brand-pink">
                    <Fingerprint className="w-6 h-6 animate-ping" />
                  </div>
                  <p className="text-xs font-bold text-brand-pink">Biometrics Confirmed...</p>
                </div>
              ) : (
                <div className="flex flex-col gap-2.5 w-full py-2 relative z-10">
                  <motion.button
                    whileTap={{ scale: 0.96 }}
                    onClick={handleBiometricSimulate}
                    className="w-full bg-brand-pink text-white py-3.5 rounded-2xl flex items-center justify-center gap-2.5 text-xs font-bold hover:bg-brand-pink-dark transition-all shadow-md shadow-brand-pink/15"
                  >
                    <Fingerprint className="w-4 h-4" />
                    <span>Unlock with Biometrics</span>
                  </motion.button>
                  
                  <button
                    onClick={() => setVerifyDiary(null)}
                    className="w-full py-2 text-xs text-brand-text-muted hover:text-brand-plum font-bold transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
