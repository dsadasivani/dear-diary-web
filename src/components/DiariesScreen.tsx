import React, { useState, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  BookOpen, Plus, Lock, ArrowLeft, Check, List, LayoutGrid, Upload
} from 'lucide-react';
import { Diary, Entry } from '../types';
import { PREDEFINED_COLORS } from '../domain/journalCatalog';
import { persistNativeLocalStorageItem } from '../mobile/nativeStorageBridge';
import { persistMediaDataUri } from '../mobile/mediaStorage';
import { diaryRepository } from '../repositories';
import { importDiaryArchive } from '../utils/diaryArchive';
import { BACKUP_PASSPHRASE_MIN_LENGTH } from '../utils/backupEncryption';

type DiaryViewMode = 'compact' | 'list';

interface DiariesScreenProps {
  diaries: Diary[];
  entries: Entry[];
  onNavigate: (tab: string, screen?: string, diaryId?: string, entryId?: string) => void;
  onRefreshDiaries: () => void | Promise<void>;
}

const EMOJI_OPTIONS = ['📔', '✈️', '🌙', '🌿', '🎨', '💼', '☕', '🏠', '🔑', '📝', '🌸', '✨'];
const FOIL_ICON_OPTIONS = ['⭐', '👑', '🕊️', '🍀', '🗝️', '💎', '🌙', '☀️', '🌸', '✨', '🔥', '🦁', '🦉', '🪐', '🐚', '🛡️'];

export default function DiariesScreen({ 
  diaries, 
  entries, 
  onNavigate,
  onRefreshDiaries
}: DiariesScreenProps) {
  const [showCreateForm, setShowCreateForm] = useState<boolean>(false);
  
  // View mode state: compact (uniform grid), list (classic list)
  const [viewMode, setViewMode] = useState<DiaryViewMode>(() => {
    return localStorage.getItem('deardiary_diary_viewmode') === 'list' ? 'list' : 'compact';
  });

  const handleViewModeChange = (mode: DiaryViewMode) => {
    setViewMode(mode);
    localStorage.setItem('deardiary_diary_viewmode', mode);
    persistNativeLocalStorageItem('deardiary_diary_viewmode', mode);
  };

  // New diary form state
  const [diaryName, setDiaryName] = useState<string>('');
  const [diaryDesc, setDiaryDesc] = useState<string>('');
  const [selectedEmoji, setSelectedEmoji] = useState<string>('📔');
  const [selectedColor, setSelectedColor] = useState<string>(PREDEFINED_COLORS[0].hex);
  const [isLocked, setIsLocked] = useState<boolean>(false);
  
  // Custom cover and foil icon state
  const [coverImage, setCoverImage] = useState<string | undefined>(undefined);
  const [selectedFoilIcons, setSelectedFoilIcons] = useState<string[]>([]);
  const coverFileInputRef = useRef<HTMLInputElement>(null);
  const archiveFileInputRef = useRef<HTMLInputElement>(null);

  const totalEntries = entries.length;

  const handleDiaryClick = (diary: Diary) => {
    onNavigate('diaries', 'diaryDetail', diary.id);
  };

  const handleCoverImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (event) => {
      if (event.target?.result) {
        const coverUri = await persistMediaDataUri(
          event.target.result as string,
          'cover',
          file.type || 'image/jpeg',
        );
        setCoverImage(coverUri);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleFoilIconToggle = (icon: string) => {
    if (selectedFoilIcons.includes(icon)) {
      setSelectedFoilIcons(prev => prev.filter(i => i !== icon));
    } else {
      if (selectedFoilIcons.length >= 4) {
        return; // Max 4 foil icons
      }
      setSelectedFoilIcons(prev => [...prev, icon]);
    }
  };

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!diaryName.trim()) return;

    await diaryRepository.createDiary({
      name: diaryName,
      emoji: selectedEmoji,
      color: selectedColor,
      isLocked,
      coverImage,
      foilIcons: selectedFoilIcons,
    });
    await onRefreshDiaries();
    
    // Reset form
    setDiaryName('');
    setDiaryDesc('');
    setSelectedEmoji('📔');
    setSelectedColor(PREDEFINED_COLORS[0].hex);
    setIsLocked(false);
    setCoverImage(undefined);
    setSelectedFoilIcons([]);
    setShowCreateForm(false);
  };

  const handleArchiveImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const passphrase = window.prompt(`Enter the archive password (${BACKUP_PASSPHRASE_MIN_LENGTH}+ characters).`);
    if (passphrase === null) return;
    try {
      const imported = await importDiaryArchive(new Uint8Array(await file.arrayBuffer()), passphrase);
      await onRefreshDiaries();
      onNavigate('diaries', 'diaryDetail', imported.id);
    } catch (error: any) {
      window.alert(error?.message || 'The diary archive could not be imported.');
    }
  };

  return (
    <div className="flex flex-col gap-6 font-sans relative">
      <AnimatePresence mode="wait">
        {!showCreateForm ? (
          /* DIARIES LIST SCREEN WITH TWO VIEW OPTIONS */
          <motion.div
            key="list"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="flex flex-col gap-6"
          >
            {/* Header */}
            <header className="flex justify-between items-center bg-brand-bg/95 backdrop-blur-md sticky top-0 py-3 z-30 select-none">
              <div className="flex items-center gap-3">
                <span className="p-2.5 bg-brand-pink/10 text-brand-pink rounded-2xl">
                  <BookOpen className="w-5 h-5" />
                </span>
                <h1 className="font-serif-diary text-3xl text-brand-plum tracking-tight font-bold">Dear Diary</h1>
              </div>
              <div className="text-[10px] font-extrabold text-brand-pink tracking-widest uppercase bg-brand-pink/5 px-4 py-2 rounded-full border border-brand-pink/10">
                {diaries.length} Books • {totalEntries} Entries
              </div>
            </header>

            {/* Title & View Selector Section */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white/40 dark:bg-brand-card-bg/20 p-4 rounded-3xl border border-brand-border/30">
              <div className="space-y-1">
                <h2 className="font-serif-diary text-2xl font-bold text-brand-plum italic">Your Bookcases</h2>
                <p className="text-xs text-brand-text-muted font-medium">Click on a journal to flip open its pages and explore your journey.</p>
              </div>

              {/* View Selector Buttons */}
              <div className="flex items-center gap-1 bg-white/90 dark:bg-brand-card-bg/90 border border-brand-border p-1 rounded-2xl shadow-sm self-start sm:self-auto">
                <button
                  type="button"
                  onClick={() => archiveFileInputRef.current?.click()}
                  className="p-2.5 rounded-xl text-brand-sage hover:bg-brand-blush-light dark:hover:bg-brand-blush-light/10"
                  title="Import portable diary archive"
                >
                  <Upload className="w-4 h-4" />
                </button>
                <button
                  onClick={() => handleViewModeChange('compact')}
                  className={`p-2.5 rounded-xl transition-all ${
                    viewMode === 'compact'
                      ? 'bg-brand-pink text-white shadow-md'
                      : 'text-brand-sage hover:bg-brand-blush-light dark:hover:bg-brand-blush-light/10'
                  }`}
                  title="Compact Cover View"
                >
                  <LayoutGrid className="w-4 h-4" />
                </button>
                <button
                  onClick={() => handleViewModeChange('list')}
                  className={`p-2.5 rounded-xl transition-all ${
                    viewMode === 'list'
                      ? 'bg-brand-pink text-white shadow-md'
                      : 'text-brand-sage hover:bg-brand-blush-light dark:hover:bg-brand-blush-light/10'
                  }`}
                  title="Classic List View"
                >
                  <List className="w-4 h-4" />
                </button>
              </div>
              <input
                ref={archiveFileInputRef}
                type="file"
                accept=".ddiary"
                onChange={event => void handleArchiveImport(event)}
                className="hidden"
              />
            </div>

            {/* CONDITIONAL RENDER BY VIEW MODE */}
            <AnimatePresence mode="wait">
              {viewMode === 'compact' && (
                /* COMPACT CARD VIEW (UNIFORM GRID) */
                <motion.div
                  key="compact"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="grid grid-cols-2 sm:grid-cols-3 gap-5 pb-24"
                >
                  {diaries.map((diary) => (
                    <motion.div
                      key={diary.id}
                      whileHover={{ y: -6 }}
                      transition={{ type: "spring", stiffness: 260, damping: 20 }}
                      onClick={() => handleDiaryClick(diary)}
                      className="group relative aspect-[3/4.2] cursor-pointer select-none"
                    >
                      {/* Double-layered realistic skeuomorphic shadow (shady effect) */}
                      <div className="absolute inset-y-1 left-3 right-1 bg-black/35 blur-[2px] rounded-r-xl pointer-events-none z-0 transition-all duration-300 group-hover:translate-x-1 group-hover:translate-y-1 group-hover:blur-[3px] group-hover:bg-black/40" />
                      <div className="absolute inset-y-3 left-4 right-0 bg-black/15 blur-lg rounded-r-xl pointer-events-none z-0 transition-all duration-300 group-hover:translate-x-2 group-hover:translate-y-2 group-hover:blur-xl group-hover:bg-black/20" />

                      {/* Tactile Satin Bookmark Ribbon */}
                      <div 
                        className="absolute bottom-[-10px] right-6 w-2.5 h-5 rounded-b shadow-[1px_2px_4px_rgba(0,0,0,0.3)] z-0 origin-top group-hover:scale-y-115 transition-all duration-300" 
                        style={{ backgroundColor: diary.color === '#8A3D55' ? '#DCA153' : '#8A3D55' }}
                      />

                      {/* Realistic Layered Pages peeking out from right and bottom */}
                      <div className="absolute top-[3px] bottom-[3px] right-[1px] left-3.5 bg-gradient-to-r from-[#d0c9b1] via-[#FAF8F3] to-[#F3EFE6] rounded-r border-y border-r border-black/10 z-0 shadow-[inset_1px_0_0_rgba(255,255,255,0.4)]" />
                      <div 
                        className="absolute top-[5px] bottom-[5px] right-[3px] left-3.5 bg-gradient-to-r from-[#c0b89b] via-[#FFFDF9] to-[#FAF6EE] rounded-r border-y border-r border-black/5 z-0"
                        style={{
                          backgroundImage: 'repeating-linear-gradient(90deg, transparent, transparent 1px, rgba(0,0,0,0.03) 1px, rgba(0,0,0,0.03) 2px)'
                        }}
                      />

                      {/* Front Cover */}
                      <div 
                        className="absolute inset-y-0 left-0 right-2 rounded-r-[14px] rounded-l-[4px] shadow-[3px_3px_12px_rgba(0,0,0,0.25)] group-hover:shadow-[6px_8px_18px_rgba(0,0,0,0.32)] border-y border-r border-white/10 flex flex-col justify-between p-3.5 z-10 overflow-hidden transition-all duration-300"
                        style={{
                          backgroundColor: diary.color,
                          backgroundImage: diary.coverImage ? `url(${diary.coverImage})` : undefined,
                          backgroundSize: 'cover',
                          backgroundPosition: 'center'
                        }}
                      >
                        {/* Cover highlight gloss with sheen sweep effect */}
                        <div className="absolute inset-0 bg-gradient-to-tr from-black/25 via-white/[0.04] to-white/[0.15] pointer-events-none z-20" />
                        
                        {/* Hover Sheen sweep effect (high fidelity gloss shine) */}
                        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/15 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-1000 ease-in-out pointer-events-none z-20" />
                        
                        {/* Realistic spine fold shading (hinge crease) */}
                        <div className="absolute left-0 top-0 bottom-0 w-3.5 bg-gradient-to-r from-black/45 via-black/15 to-transparent pointer-events-none z-20" />

                        {/* Page opening edge soft shadow to convey cover thickness */}
                        <div className="absolute right-0 top-0 bottom-0 w-2 bg-gradient-to-l from-black/20 to-transparent pointer-events-none z-20" />
                        <div className="absolute right-1 top-0 bottom-0 w-[1px] bg-white/10 pointer-events-none z-20" />
                        
                        {/* Spine binding lines */}
                        <div className="absolute left-[11px] top-0 bottom-0 w-[1px] bg-black/25 pointer-events-none z-20" />
                        <div className="absolute left-[12px] top-0 bottom-0 w-[1px] bg-white/10 pointer-events-none z-20" />

                        {/* Raised spine bands */}
                        <div className="absolute left-0 top-[20%] w-3 h-[2.5px] bg-black/20 border-b border-white/5 z-20 pointer-events-none shadow-[0_1px_0_rgba(0,0,0,0.1)]" />
                        <div className="absolute left-0 top-[40%] w-3 h-[2.5px] bg-black/20 border-b border-white/5 z-20 pointer-events-none shadow-[0_1px_0_rgba(0,0,0,0.1)]" />
                        <div className="absolute left-0 top-[60%] w-3 h-[2.5px] bg-black/20 border-b border-white/5 z-20 pointer-events-none shadow-[0_1px_0_rgba(0,0,0,0.1)]" />
                        <div className="absolute left-0 top-[80%] w-3 h-[2.5px] bg-black/20 border-b border-white/5 z-20 pointer-events-none shadow-[0_1px_0_rgba(0,0,0,0.1)]" />

                        {/* Gold corners */}
                        {!diary.coverImage && (
                          <>
                            <div className="absolute top-0 right-0 w-3 h-3 border-t border-r border-yellow-500/40 rounded-tr-lg pointer-events-none z-20" />
                            <div className="absolute bottom-0 right-0 w-3 h-3 border-b border-r border-yellow-500/40 rounded-br-lg pointer-events-none z-20" />
                          </>
                        )}

                        {diary.coverImage && (
                          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/30 to-black/10 z-10" />
                        )}

                        <div className="flex justify-between items-start relative z-20 pl-1">
                          <span className="w-7 h-7 rounded-lg bg-white/95 flex items-center justify-center text-xs shadow-sm">
                            {diary.emoji}
                          </span>
                          {diary.isLocked && (
                            <span className="p-1 bg-black/20 backdrop-blur-sm rounded-md text-white">
                              <Lock className="w-2.5 h-2.5" />
                            </span>
                          )}
                        </div>

                        {/* Foil stamps preview inside compact cover */}
                        {diary.foilIcons && diary.foilIcons.length > 0 && (
                          <div className="flex flex-wrap gap-1 bg-yellow-500/15 backdrop-blur-md border border-yellow-500/35 px-1.5 py-1 rounded-lg max-w-max relative z-20 mt-1.5 ml-1">
                            {diary.foilIcons.slice(0, 4).map((icon, idx) => (
                              <span key={idx} className="text-[10px] filter drop-shadow-[0_1px_1px_rgba(234,179,8,0.95)]">{icon}</span>
                            ))}
                          </div>
                        )}

                        <div className="bg-white/95 dark:bg-brand-card-bg/95 p-2 rounded-lg shadow-md border border-brand-border/10 relative z-20 mt-auto ml-1">
                          <h3 className="font-serif-diary font-bold text-[11px] text-brand-plum truncate leading-tight">
                            {diary.name}
                          </h3>
                          <p className="text-[7.5px] font-extrabold text-brand-pink-dark uppercase tracking-wider mt-0.5">
                            {diary.entryCount} entries
                          </p>
                        </div>
                      </div>
                    </motion.div>
                  ))}
                </motion.div>
              )}

              {viewMode === 'list' && (
                /* CLASSIC LIST VIEW */
                <motion.div
                  key="list"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="flex flex-col gap-4.5 pb-24"
                >
                  {diaries.map((diary) => (
                    <motion.div
                      key={diary.id}
                      whileHover={{ x: 4, scale: 1.01 }}
                      onClick={() => handleDiaryClick(diary)}
                      className="group relative overflow-hidden bg-white dark:bg-brand-card-bg rounded-2xl p-4.5 cursor-pointer border border-brand-border/60 dark:border-brand-border/10 shadow-sm flex items-center justify-between transition-all select-none hover:shadow-md"
                    >
                      <div className="flex items-center gap-4">
                        {/* Tiny Spine Accent represent the book */}
                        <div 
                          className="w-4 h-15 rounded-md relative overflow-hidden flex-shrink-0 shadow-inner"
                          style={{
                            backgroundColor: diary.color,
                            backgroundImage: diary.coverImage ? `url(${diary.coverImage})` : undefined,
                            backgroundSize: 'cover',
                            backgroundPosition: 'center'
                          }}
                        >
                          <div className="absolute left-0 top-0 bottom-0 w-1 bg-black/20" />
                          <div className="absolute inset-0 bg-white/5 pointer-events-none" />
                        </div>

                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <span className="text-sm">{diary.emoji}</span>
                            <h3 className="font-serif-diary font-bold text-base text-brand-plum group-hover:text-brand-pink transition-colors">
                              {diary.name}
                            </h3>
                            {diary.isLocked && <Lock className="w-3.5 h-3.5 text-brand-sage" />}
                          </div>
                          
                          <div className="flex items-center gap-3 text-[10px] font-bold text-brand-text-muted">
                            <span>{diary.entryCount} {diary.entryCount === 1 ? 'entry' : 'entries'}</span>
                            <span className="w-1 h-1 bg-brand-border rounded-full" />
                            <span className="italic">Updated {diary.lastUpdated.toLowerCase()}</span>
                          </div>
                        </div>
                      </div>

                      {/* Embossed foil stamps in list item row */}
                      {diary.foilIcons && diary.foilIcons.length > 0 && (
                        <div className="flex gap-1 bg-yellow-500/10 border border-yellow-500/25 px-2 py-1 rounded-xl">
                          {diary.foilIcons.map((icon, idx) => (
                            <span key={idx} className="text-xs filter drop-shadow-[0_1px_1px_rgba(234,179,8,0.95)]">{icon}</span>
                          ))}
                        </div>
                      )}
                    </motion.div>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>

            {/* Floating Create FAB */}
            <motion.button 
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={() => setShowCreateForm(true)}
              className="fixed bottom-24 right-6 md:right-10 w-15 h-15 bg-brand-pink hover:bg-brand-pink-dark text-white rounded-3xl flex items-center justify-center shadow-xl shadow-brand-pink/20 transition-all z-40 border border-brand-pink-dark/10"
              title="Bind a new journal"
            >
              <Plus className="w-7 h-7" />
            </motion.button>
          </motion.div>
        ) : (
          /* CREATE DIARY SCREEN */
          <motion.div
            key="create"
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 15 }}
            className="flex flex-col gap-6 pb-28"
          >
            {/* Header */}
            <header className="flex justify-between items-center py-3 bg-brand-bg sticky top-0 z-30 border-b border-brand-border/40 select-none">
              <button 
                onClick={() => setShowCreateForm(false)}
                className="p-2.5 text-brand-plum hover:bg-brand-blush-light dark:hover:bg-brand-blush-light/10 rounded-full transition-all active:scale-90"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
              <h1 className="font-serif-diary text-xl font-bold text-brand-plum italic">Bind a New Journal</h1>
              <div className="w-10 h-10" />
            </header>

            <form onSubmit={handleCreateSubmit} className="flex flex-col gap-6">
              
              {/* Cover Preview Card with Custom cover and Foil seals support */}
              <div className="flex flex-col items-center py-6 select-none">
                <div className="w-44 aspect-[3/4.2] relative">
                  {/* Double-layered realistic skeuomorphic shadow (shady effect) */}
                  <div className="absolute inset-y-1 left-3 right-1 bg-black/35 blur-[2px] rounded-r-xl pointer-events-none z-0 transition-all duration-300" />
                  <div className="absolute inset-y-3 left-4 right-0 bg-black/15 blur-lg rounded-r-xl pointer-events-none z-0 transition-all duration-300" />

                  {/* Bookmark ribbon */}
                  <div 
                    className="absolute bottom-[-10px] right-8 w-2.5 h-5 rounded-b shadow-[1px_2px_4px_rgba(0,0,0,0.3)] z-0" 
                    style={{ backgroundColor: selectedColor === '#8A3D55' ? '#DCA153' : '#8A3D55' }}
                  />

                  {/* Layered paper pages peeking */}
                  <div className="absolute top-[3px] bottom-[3px] right-[1px] left-3.5 bg-gradient-to-r from-[#d0c9b1] via-[#FAF8F3] to-[#F3EFE6] rounded-r border-y border-r border-black/10 z-0 shadow-[inset_1px_0_0_rgba(255,255,255,0.4)]" />
                  <div 
                    className="absolute top-[5px] bottom-[5px] right-[3px] left-3.5 bg-gradient-to-r from-[#c0b89b] via-[#FFFDF9] to-[#FAF6EE] rounded-r border-y border-r border-black/5 z-0"
                    style={{
                      backgroundImage: 'repeating-linear-gradient(90deg, transparent, transparent 1px, rgba(0,0,0,0.03) 1px, rgba(0,0,0,0.03) 2px)'
                    }}
                  />

                  {/* Front Cover */}
                  <motion.div 
                    animate={{ backgroundColor: coverImage ? undefined : selectedColor }}
                    className="absolute inset-y-0 left-0 right-2 rounded-r-[14px] rounded-l-[4px] shadow-[3px_3px_12px_rgba(0,0,0,0.25)] border-y border-r border-white/10 flex flex-col justify-between p-3.5 z-10 overflow-hidden"
                    style={{
                      backgroundImage: coverImage ? `url(${coverImage})` : undefined,
                      backgroundSize: 'cover',
                      backgroundPosition: 'center'
                    }}
                  >
                    {/* Cover gloss highlight */}
                    <div className="absolute inset-0 bg-gradient-to-tr from-black/25 via-white/[0.04] to-white/[0.15] pointer-events-none z-20" />
                    
                    {/* Spine shading with skeuomorphic fold depth */}
                    <div className="absolute left-0 top-0 bottom-0 w-3.5 bg-gradient-to-r from-black/45 via-black/15 to-transparent pointer-events-none z-20" />
                    
                    {/* Vertical binding lines */}
                    <div className="absolute left-[11px] top-0 bottom-0 w-[1px] bg-black/25 pointer-events-none z-20" />
                    <div className="absolute left-[12px] top-0 bottom-0 w-[1px] bg-white/10 pointer-events-none z-20" />

                    {/* Spine ridges */}
                    <div className="absolute left-0 top-[20%] w-3 h-[2.5px] bg-black/20 border-b border-white/5 z-20 pointer-events-none shadow-[0_1px_0_rgba(0,0,0,0.1)]" />
                    <div className="absolute left-0 top-[40%] w-3 h-[2.5px] bg-black/20 border-b border-white/5 z-20 pointer-events-none shadow-[0_1px_0_rgba(0,0,0,0.1)]" />
                    <div className="absolute left-0 top-[60%] w-3 h-[2.5px] bg-black/20 border-b border-white/5 z-20 pointer-events-none shadow-[0_1px_0_rgba(0,0,0,0.1)]" />
                    <div className="absolute left-0 top-[80%] w-3 h-[2.5px] bg-black/20 border-b border-white/5 z-20 pointer-events-none shadow-[0_1px_0_rgba(0,0,0,0.1)]" />

                    {/* Vintage corners */}
                    {!coverImage && (
                      <>
                        <div className="absolute top-0 right-0 w-3 h-3 border-t border-r border-yellow-500/40 rounded-tr-lg pointer-events-none z-20" />
                        <div className="absolute bottom-0 right-0 w-3 h-3 border-b border-r border-yellow-500/40 rounded-br-lg pointer-events-none z-20" />
                      </>
                    )}

                    {coverImage && (
                      <div className="absolute inset-0 bg-black/40 z-10" />
                    )}

                    <div className="flex justify-between items-start relative z-25 pl-1">
                      <span className="w-8 h-8 rounded-lg bg-white/95 flex items-center justify-center text-md shadow-sm text-brand-plum">
                        {selectedEmoji}
                      </span>
                      {isLocked && (
                        <span className="p-1 bg-black/20 backdrop-blur-sm rounded-md text-white">
                          <Lock className="w-2.5 h-2.5" />
                        </span>
                      )}
                    </div>

                    {/* Foil stamps preview inside preview cover */}
                    {selectedFoilIcons.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2 bg-yellow-500/20 backdrop-blur-md border border-yellow-500/40 px-1.5 py-1 rounded-lg max-w-max self-start relative z-25 ml-1">
                        {selectedFoilIcons.map((icon, idx) => (
                          <span key={idx} className="text-[10px] filter drop-shadow-[0_1.5px_1.5px_rgba(234,179,8,0.95)]">{icon}</span>
                        ))}
                      </div>
                    )}

                    <div className="bg-white/95 dark:bg-brand-card-bg/95 p-2.5 rounded-lg shadow-md border border-brand-border/15 ml-1 relative z-25">
                      <h3 className="font-serif-diary font-bold text-[11px] leading-tight text-brand-plum truncate">
                        {diaryName || 'Untangled Pages'}
                      </h3>
                      <p className="text-[7px] font-bold text-brand-pink-dark uppercase tracking-widest mt-0.5">
                        Custom Bound Cover
                      </p>
                    </div>
                  </motion.div>
                </div>
                <p className="text-[10px] text-brand-text-muted font-bold uppercase tracking-wider mt-4">Cover Art Preview</p>
              </div>

              {/* Basic Info Section */}
              <div className="flex flex-col gap-5 bg-white/90 dark:bg-brand-card-bg p-6 rounded-[32px] border border-brand-border/80 dark:border-brand-border/10 shadow-sm">
                <div className="flex flex-col gap-1.5">
                  <label className="text-[10px] font-extrabold text-brand-pink uppercase tracking-widest">Journal Title</label>
                  <input 
                    type="text" 
                    value={diaryName}
                    onChange={(e) => setDiaryName(e.target.value)}
                    placeholder="e.g., Midnight Musings"
                    required
                    maxLength={32}
                    className="w-full bg-transparent border-b border-brand-border/60 py-2.5 text-base text-brand-plum focus:outline-none focus:border-brand-pink transition-colors font-serif-diary placeholder-brand-plum/25 font-semibold"
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-[10px] font-extrabold text-brand-pink uppercase tracking-widest">Aesthetic Intent (Optional)</label>
                  <textarea 
                    value={diaryDesc}
                    onChange={(e) => setDiaryDesc(e.target.value)}
                    placeholder="Describe the emotional theme or goal for this specific journal..."
                    rows={2}
                    maxLength={140}
                    className="w-full bg-transparent border-b border-brand-border/60 py-2 text-sm text-brand-plum focus:outline-none focus:border-brand-pink transition-colors font-serif-diary resize-none placeholder-brand-plum/25 leading-relaxed"
                  />
                </div>
              </div>

              {/* Cover Page Background Image Upload */}
              <div className="flex flex-col gap-3.5 bg-white/90 dark:bg-brand-card-bg p-6 rounded-[32px] border border-brand-border/80 dark:border-brand-border/10 shadow-sm">
                <div className="flex justify-between items-center">
                  <label className="text-[10px] font-extrabold text-brand-pink uppercase tracking-widest">Custom Cover Image</label>
                  {coverImage && (
                    <button
                      type="button"
                      onClick={() => setCoverImage(undefined)}
                      className="text-[10px] font-extrabold text-red-500 uppercase tracking-widest hover:underline"
                    >
                      Clear Image
                    </button>
                  )}
                </div>
                
                <div className="flex items-center gap-4">
                  <button
                    type="button"
                    onClick={() => coverFileInputRef.current?.click()}
                    className="flex items-center gap-2 px-4 py-2.5 bg-brand-pink/10 hover:bg-brand-pink/15 text-brand-pink border border-brand-pink/20 rounded-2xl text-xs font-bold transition-all active:scale-95"
                  >
                    <Upload className="w-4 h-4" />
                    <span>Upload Background Cover</span>
                  </button>
                  <input
                    ref={coverFileInputRef}
                    type="file"
                    accept="image/*"
                    onChange={handleCoverImageUpload}
                    className="hidden"
                  />
                  {coverImage && (
                    <div className="w-10 h-10 rounded-lg overflow-hidden border border-brand-border shadow-sm">
                      <img src={coverImage} alt="Cover upload" className="w-full h-full object-cover" />
                    </div>
                  )}
                </div>
                <p className="text-[10px] text-brand-text-muted">Upload any photo (JPG/PNG) to wrap your journal cover instead of solid colors.</p>
              </div>

              {/* Cover Emoji Selector */}
              <div className="flex flex-col gap-3.5 bg-white/90 dark:bg-brand-card-bg p-6 rounded-[32px] border border-brand-border/80 dark:border-brand-border/10 shadow-sm">
                <label className="text-[10px] font-extrabold text-brand-pink uppercase tracking-widest">Embossed Foil Icon</label>
                <div className="grid grid-cols-6 gap-2.5">
                  {EMOJI_OPTIONS.map(emoji => (
                    <button
                      key={emoji}
                      type="button"
                      onClick={() => setSelectedEmoji(emoji)}
                      className={`aspect-square text-xl flex items-center justify-center rounded-2xl transition-all ${
                        selectedEmoji === emoji 
                          ? 'bg-brand-pink/15 text-brand-pink-dark border-2 border-brand-pink scale-110 shadow-sm' 
                          : 'bg-brand-bg/50 hover:bg-brand-blush-light dark:hover:bg-brand-blush-light/10 text-brand-plum'
                      }`}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>

              {/* Point 6: Embossed Foil Seals Multi-Selection */}
              <div className="flex flex-col gap-3.5 bg-white/90 dark:bg-brand-card-bg p-6 rounded-[32px] border border-brand-border/80 dark:border-brand-border/10 shadow-sm">
                <div className="flex justify-between items-center">
                  <label className="text-[10px] font-extrabold text-brand-pink uppercase tracking-widest">Embossed Gold Foil Seals ({selectedFoilIcons.length}/4)</label>
                  {selectedFoilIcons.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setSelectedFoilIcons([])}
                      className="text-[10px] font-extrabold text-brand-pink-dark uppercase tracking-widest hover:underline"
                    >
                      Reset Foil Stamps
                    </button>
                  )}
                </div>
                
                <p className="text-[11px] text-brand-text-muted mt-0.5">Toggle up to 4 shiny gold metallic seals to stamp onto your notebook cover.</p>
                
                <div className="grid grid-cols-6 gap-2.5">
                  {FOIL_ICON_OPTIONS.map(icon => {
                    const isSelected = selectedFoilIcons.includes(icon);
                    return (
                      <button
                        key={icon}
                        type="button"
                        onClick={() => handleFoilIconToggle(icon)}
                        className={`aspect-square text-xl flex items-center justify-center rounded-2xl relative transition-all ${
                          isSelected 
                            ? 'bg-yellow-500/20 text-yellow-600 border-2 border-yellow-500 scale-110 shadow-md' 
                            : 'bg-brand-bg/50 hover:bg-brand-blush-light dark:hover:bg-brand-blush-light/10 text-brand-plum'
                        }`}
                      >
                        {icon}
                        {isSelected && (
                          <div className="absolute top-1 right-1 w-3 h-3 bg-yellow-500 rounded-full flex items-center justify-center border border-white">
                            <Check className="w-2 h-2 text-white stroke-[5px]" />
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Cover Theme Palette Selection */}
              <div className="flex flex-col gap-3.5 bg-white/90 dark:bg-brand-card-bg p-6 rounded-[32px] border border-brand-border/80 dark:border-brand-border/10 shadow-sm">
                <label className="text-[10px] font-extrabold text-brand-pink uppercase tracking-widest">Cover Leather Color</label>
                <div className="grid grid-cols-6 gap-3">
                  {PREDEFINED_COLORS.map(color => (
                    <button
                      key={color.hex}
                      type="button"
                      onClick={() => setSelectedColor(color.hex)}
                      disabled={!!coverImage}
                      className={`aspect-square rounded-2xl relative flex items-center justify-center shadow-md transition-transform hover:scale-105 ${
                        coverImage ? 'opacity-30 cursor-not-allowed' : ''
                      }`}
                      style={{ backgroundColor: color.hex }}
                    >
                      {selectedColor === color.hex && !coverImage && (
                        <div className="w-6 h-6 rounded-full bg-white flex items-center justify-center text-brand-pink shadow-sm">
                          <Check className="w-3.5 h-3.5 stroke-[4px]" />
                        </div>
                      )}
                    </button>
                  ))}
                </div>
                {coverImage && <p className="text-[10px] text-amber-600 font-semibold">Custom cover image is active, backing leather color is hidden.</p>}
              </div>

              {/* Password Protection Toggle */}
              <div className="bg-white/90 dark:bg-brand-card-bg p-6 rounded-[32px] border border-brand-border/80 dark:border-brand-border/10 shadow-sm flex items-center justify-between">
                <div className="flex items-center gap-3.5">
                  <span className="p-3 bg-brand-pink/10 text-brand-pink rounded-2xl">
                    <Lock className="w-4.5 h-4.5" />
                  </span>
                  <div>
                    <h3 className="text-sm font-bold text-brand-plum">Private Lock Status</h3>
                    <p className="text-[11px] text-brand-text-muted mt-0.5">Encrypt and protect this book with biometrics</p>
                  </div>
                </div>

                <label className="relative inline-flex items-center cursor-pointer">
                  <input 
                    type="checkbox" 
                    checked={isLocked}
                    onChange={(e) => setIsLocked(e.target.checked)}
                    className="sr-only peer" 
                  />
                  <div className="w-11 h-6 bg-brand-sage-light/50 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-brand-sage-light after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-brand-sage" />
                </label>
              </div>

              {/* Footer Actions */}
              <footer className="flex gap-4 pt-4 select-none">
                <button
                  type="button"
                  onClick={() => setShowCreateForm(false)}
                  className="flex-1 py-3.5 rounded-full border border-brand-pink text-brand-pink font-bold text-xs hover:bg-brand-pink/5 transition-all active:scale-95"
                >
                  Discard Setup
                </button>
                <button
                  type="submit"
                  disabled={!diaryName.trim()}
                  className="flex-1 py-3.5 rounded-full bg-brand-pink disabled:opacity-40 hover:bg-brand-pink-dark text-white font-bold text-xs shadow-lg shadow-brand-pink/15 transition-all active:scale-95"
                >
                  Bind Cover
                </button>
              </footer>
            </form>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
