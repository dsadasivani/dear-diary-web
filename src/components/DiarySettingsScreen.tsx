import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ArrowLeft, Trash2, Check, Lock, ShieldAlert, Smile, Palette, Save, ShieldCheck } from 'lucide-react';
import { Diary } from '../types';
import { PREDEFINED_COLORS } from '../domain/journalCatalog';
import { diaryRepository } from '../repositories';

interface DiarySettingsScreenProps {
  diary: Diary;
  onBack: () => void;
  onRefreshDiaries: () => void | Promise<void>;
}

const EMOJI_OPTIONS = ['📔', '✈️', '💼', '🌙', '🎨', '🌿', '☕', '🏠', '🔑', '📝', '🌸', '✨'];
const FOIL_ICON_OPTIONS = ['⭐', '👑', '🕊️', '🍀', '🗝️', '💎', '🌙', '☀️', '🌸', '✨', '🔥', '🦁', '🦉', '🪐', '🐚', '🛡️'];

export default function DiarySettingsScreen({
  diary,
  onBack,
  onRefreshDiaries
}: DiarySettingsScreenProps) {
  const [diaryName, setDiaryName] = useState<string>(diary.name);
  const [selectedEmoji, setSelectedEmoji] = useState<string>(diary.emoji);
  const [selectedColor, setSelectedColor] = useState<string>(diary.color);
  const [isLocked, setIsLocked] = useState<boolean>(diary.isLocked);
  const [showConfirmDelete, setShowConfirmDelete] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<'look' | 'settings'>('settings');

  // Cover decoration states
  const [selectedFoilIcons, setSelectedFoilIcons] = useState<string[]>(diary.foilIcons || []);

  const handleSave = async () => {
    if (!diaryName.trim()) return;

    const updated: Diary = {
      ...diary,
      name: diaryName,
      emoji: selectedEmoji,
      color: selectedColor,
      isLocked,
      foilIcons: selectedFoilIcons
    };

    await diaryRepository.updateDiary(updated);
    await onRefreshDiaries();
    onBack();
  };

  const handleDelete = async () => {
    await diaryRepository.deleteDiary(diary.id);
    await onRefreshDiaries();
    onBack();
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

  return (
    <div className="flex flex-col gap-6 font-sans">
      {/* Header */}
      <header className="flex justify-between items-center bg-brand-bg/95 backdrop-blur-md sticky top-0 py-3 z-30 border-b border-brand-rose-light/40">
        <div className="flex items-center gap-2">
          <button 
            onClick={onBack}
            className="p-2 text-brand-plum hover:bg-brand-blush-light rounded-full transition-all"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <h1 className="font-serif-diary text-xl font-bold text-brand-plum">Journal Settings</h1>
        </div>
        <button 
          onClick={handleSave}
          disabled={!diaryName.trim()}
          className="p-2 text-brand-pink hover:text-brand-pink-dark font-bold text-sm flex items-center gap-1 transition-colors"
        >
          <Save className="w-4 h-4" />
          Save
        </button>
      </header>

      {/* Main Form content */}
      <div className="flex flex-col gap-6">
        
        {/* Real-time Cover Preview Card */}
        <div className="flex flex-col items-center py-4 select-none bg-brand-card-bg/40 p-4 rounded-3xl border border-brand-border/40">
          <motion.div 
            animate={{ backgroundColor: selectedColor }}
            className="w-40 aspect-[3/4.2] rounded-3xl shadow-xl relative border border-black/10 flex flex-col justify-between p-4 overflow-hidden"
          >
            <div className="absolute left-0 top-0 bottom-0 w-3 bg-gradient-to-r from-black/25 via-black/5 to-transparent z-10" />
            <div className="absolute left-2.5 top-0 bottom-0 w-[1px] bg-white/25 z-15" />

            <div className="flex justify-between items-start relative z-10">
              <span className="w-8 h-8 rounded-xl bg-white/95 flex items-center justify-center text-base shadow-sm text-brand-plum">
                {selectedEmoji}
              </span>
              {isLocked && (
                <span className="p-1 bg-black/15 rounded-lg text-white">
                  <Lock className="w-3.5 h-3.5" />
                </span>
              )}
            </div>

            {/* Foil stamps preview inside preview cover */}
            {selectedFoilIcons.length > 0 && (
              <div className="flex flex-wrap gap-1 bg-yellow-500/20 backdrop-blur-md border border-yellow-500/40 px-1.5 py-1 rounded-lg max-w-max self-start relative z-10 mt-1">
                {selectedFoilIcons.map((icon, idx) => (
                  <span key={idx} className="text-[10px] filter drop-shadow-[0_1px_1px_rgba(234,179,8,0.95)]">{icon}</span>
                ))}
              </div>
            )}

            <div className="bg-white/95 dark:bg-brand-card-bg/95 p-2.5 rounded-xl shadow-md border border-brand-border/20 relative z-10">
              <h3 className="font-serif-diary font-bold text-xs leading-none text-brand-plum truncate">
                {diaryName || 'Untitled book'}
              </h3>
              <p className="text-[7px] font-bold text-brand-pink-dark uppercase tracking-widest mt-1">
                Custom Bound Cover
              </p>
            </div>
          </motion.div>
          <p className="text-[10px] text-brand-text-muted font-bold uppercase tracking-wider mt-3">Live Cover Preview</p>
        </div>
        
        {/* Tab Navigation */}
        <div className="flex bg-brand-bg/50 dark:bg-brand-card-bg/40 p-1.5 rounded-2xl border border-brand-border/60 dark:border-white/5 shadow-inner gap-1 overflow-x-auto no-scrollbar scroll-smooth">
          {[
            { 
              id: 'look' as const, 
              label: 'Appearance',
              icon: Palette,
              activeBg: 'bg-brand-pink',
              activeShadow: 'shadow-[0_4px_12px_rgba(181,66,97,0.25)]',
              colorClass: 'text-brand-pink'
            },
            { 
              id: 'settings' as const, 
              label: 'Basics & Privacy',
              icon: ShieldCheck,
              activeBg: 'bg-brand-sage',
              activeShadow: 'shadow-[0_4px_12px_rgba(69,98,80,0.25)]',
              colorClass: 'text-brand-sage'
            },
          ].map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className="relative flex-1 py-2 px-2.5 rounded-xl text-xs font-bold transition-all flex items-center justify-center cursor-pointer select-none group active:scale-[0.98]"
              >
                {isActive && (
                  <motion.div
                    layoutId="diarySettingsActiveTab"
                    className={`absolute inset-0 ${tab.activeBg} rounded-xl ${tab.activeShadow}`}
                    transition={{ type: "spring", stiffness: 380, damping: 30 }}
                  />
                )}
                <span className={`relative z-10 flex items-center justify-center gap-1.5 transition-all duration-300 ${
                  isActive 
                    ? 'text-white scale-[1.03] tracking-wide' 
                    : 'text-brand-text-muted dark:text-brand-text-muted/80 group-hover:text-brand-plum dark:group-hover:text-brand-text'
                }`}>
                  <Icon className={`w-3.5 h-3.5 shrink-0 transition-all duration-300 ${
                    isActive 
                      ? 'scale-110 text-white' 
                      : `${tab.colorClass} opacity-75 group-hover:opacity-100 group-hover:scale-110`
                  }`} />
                  <span>{tab.label}</span>
                </span>

                {/* Subtle hover background capsule for interactive tactile feel */}
                {!isActive && (
                  <div className="absolute inset-0 rounded-xl bg-brand-blush-light/0 dark:bg-white/0 group-hover:bg-brand-blush-light/40 dark:group-hover:bg-white/5 transition-colors duration-200 -z-0 pointer-events-none" />
                )}
              </button>
            );
          })}
        </div>

        <AnimatePresence mode="wait">
          {activeTab === 'look' ? (
            <motion.div
              key="look"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.15 }}
              className="flex flex-col gap-6"
            >
              {/* Color Palette Selector Card */}
              <div className="bg-brand-card-bg p-5 rounded-3xl journal-shadow border border-brand-border flex flex-col gap-3">
                <label className="text-xs font-bold text-brand-sage uppercase tracking-wider flex items-center gap-1">
                  <Palette className="w-4 h-4 text-brand-sage" />
                  Cover theme color
                </label>
                <div className="grid grid-cols-6 gap-3">
                  {PREDEFINED_COLORS.map(color => (
                    <button
                      key={color.hex}
                      type="button"
                      onClick={() => setSelectedColor(color.hex)}
                      className="aspect-square rounded-xl relative flex items-center justify-center shadow-sm transition-transform hover:scale-105"
                      style={{ backgroundColor: color.hex }}
                      aria-label={`Use ${color.name} cover color`}
                      aria-pressed={selectedColor === color.hex}
                    >
                      {selectedColor === color.hex && (
                        <Check className="w-5 h-5 text-white stroke-[3px]" />
                      )}
                    </button>
                  ))}
                </div>
              </div>

              {/* Emoji Selector Card */}
              <div className="bg-brand-card-bg p-5 rounded-3xl journal-shadow border border-brand-border flex flex-col gap-3">
                <label className="text-xs font-bold text-brand-sage uppercase tracking-wider flex items-center gap-1">
                  <Smile className="w-4 h-4 text-brand-sage" />
                  Cover Icon Emoji
                </label>
                <div className="flex flex-wrap gap-2">
                  {EMOJI_OPTIONS.map(emoji => (
                    <button
                      key={emoji}
                      type="button"
                      onClick={() => setSelectedEmoji(emoji)}
                      aria-label={`Use ${emoji} as journal icon`}
                      aria-pressed={selectedEmoji === emoji}
                      className={`w-11 h-11 text-xl flex items-center justify-center rounded-xl transition-all ${
                        selectedEmoji === emoji 
                          ? 'bg-brand-sage-light dark:bg-brand-sage-light/10 text-brand-sage-dark border-2 border-brand-sage scale-110' 
                          : 'bg-brand-bg hover:bg-brand-blush-light dark:hover:bg-brand-blush-light/10'
                      }`}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>

              {/* Embossed Foil Seals selector card */}
              <div className="bg-brand-card-bg p-5 rounded-3xl journal-shadow border border-brand-border flex flex-col gap-3">
                <div className="flex justify-between items-center">
                  <label className="text-xs font-bold text-brand-sage uppercase tracking-wider">
                    Embossed Foil Stamps ({selectedFoilIcons.length}/4)
                  </label>
                  {selectedFoilIcons.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setSelectedFoilIcons([])}
                      className="text-[10px] font-extrabold text-brand-pink-dark uppercase tracking-widest hover:underline"
                    >
                      Reset Stamps
                    </button>
                  )}
                </div>
                
                <div className="grid grid-cols-6 gap-2">
                  {FOIL_ICON_OPTIONS.map(icon => {
                    const isSelected = selectedFoilIcons.includes(icon);
                    return (
                      <button
                        key={icon}
                        type="button"
                        onClick={() => handleFoilIconToggle(icon)}
                        className={`aspect-square text-lg flex items-center justify-center rounded-xl relative transition-all ${
                          isSelected 
                            ? 'bg-yellow-500/20 text-yellow-600 border-2 border-yellow-500 scale-110 shadow-sm' 
                            : 'bg-brand-bg hover:bg-brand-blush-light dark:hover:bg-brand-blush-light/10 text-brand-plum'
                        }`}
                      >
                        {icon}
                        {isSelected && (
                          <div className="absolute top-0.5 right-0.5 w-2.5 h-2.5 bg-yellow-500 rounded-full flex items-center justify-center">
                            <Check className="w-1.5 h-1.5 text-white stroke-[5px]" />
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="settings"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.15 }}
              className="flex flex-col gap-6"
            >
              {/* Name Input Card */}
              <div className="bg-brand-card-bg p-5 rounded-3xl journal-shadow border border-brand-border flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-bold text-brand-sage uppercase tracking-wider">Journal Name</label>
                  <input 
                    type="text" 
                    value={diaryName}
                    onChange={(e) => setDiaryName(e.target.value)}
                    placeholder="Journal name"
                    className="w-full bg-transparent border-b border-brand-border py-2 text-base text-brand-plum font-serif-diary focus:outline-none focus:border-brand-pink transition-colors"
                  />
                </div>
              </div>

              {/* Private diary lock card */}
              <div className="bg-brand-card-bg p-5 rounded-3xl journal-shadow border border-brand-border flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="p-2.5 bg-brand-blush-light dark:bg-brand-blush-light/10 text-brand-pink rounded-2xl">
                    <Lock className="w-4 h-4" />
                  </span>
                  <div>
                    <h3 className="text-sm font-bold text-brand-plum">Private Journal Lock</h3>
                    <p className="text-[11px] text-brand-sage mt-0.5">Require your app PIN to open this journal</p>
                  </div>
                </div>

                <label className="relative inline-flex items-center cursor-pointer">
                  <input 
                    type="checkbox" 
                    aria-label="Require the app PIN to open this journal"
                    checked={isLocked}
                    onChange={(e) => setIsLocked(e.target.checked)}
                    className="sr-only peer" 
                  />
                  <div className="w-11 h-6 bg-brand-sage-light/50 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-brand-sage-light after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-brand-sage" />
                </label>
              </div>

              {/* Delete Diary Zone */}
              <div className="bg-red-50/50 p-5 rounded-3xl border border-red-100 flex flex-col gap-4 mt-4">
                <div className="flex items-center gap-3 text-red-700">
                  <ShieldAlert className="w-5 h-5" />
                  <h3 className="text-sm font-bold">Danger Zone</h3>
                </div>
                <p className="text-xs text-red-600/90 leading-relaxed">
                  Deleting this journal permanently removes its entries and memories from this device and synced backups.
                </p>

                {!showConfirmDelete ? (
                  <button
                    type="button"
                    onClick={() => setShowConfirmDelete(true)}
                    className="py-2.5 rounded-full bg-red-100 hover:bg-red-200 text-red-700 text-xs font-bold transition-all flex items-center justify-center gap-1.5"
                  >
                    <Trash2 className="w-4 h-4" />
                    Delete Journal
                  </button>
                ) : (
                  <div className="flex flex-col gap-2">
                    <p className="text-xs font-bold text-red-700 text-center">Are you absolutely sure?</p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setShowConfirmDelete(false)}
                        className="flex-1 py-2 bg-brand-card-bg border border-red-200 text-red-700 rounded-full text-xs font-bold"
                      >
                        No, cancel
                      </button>
                      <button
                        type="button"
                        onClick={handleDelete}
                        className="flex-1 py-2 bg-red-600 hover:bg-red-700 text-white rounded-full text-xs font-bold transition-colors"
                      >
                        Yes, delete
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
