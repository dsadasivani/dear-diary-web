import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Home, BookOpen, ClipboardList, Search, BarChart2, Lock, X
} from 'lucide-react';

// Import our modular screens
import LockScreen from './components/LockScreen';
import HomeScreen from './components/HomeScreen';
import DiariesScreen from './components/DiariesScreen';
import DiaryDetailScreen from './components/DiaryDetailScreen';
import DiarySettingsScreen from './components/DiarySettingsScreen';
import EntryEditorScreen from './components/EntryEditorScreen';
import NotesScreen from './components/NotesScreen';
import SearchScreen from './components/SearchScreen';
import StatsScreen from './components/StatsScreen';
import AppSettingsScreen from './components/AppSettingsScreen';

import { Diary, Entry, Note, UserProfile } from './types';
import { addNativeBackListener, exitNativeApp, syncNativeStatusBar } from './mobile/capacitorBootstrap';
import { isAndroid } from './platform';

// Import our local storage utilities
import { 
  getDiaries, getEntries, getNotes, getSecurityConfig, 
  createNote, createEntry, getAppSettings, getUserProfile
} from './utils/storage';

export default function App() {
  // Authentication states
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  
  // Navigation states
  const [activeTab, setActiveTab] = useState<string>('home'); // home, diaries, notes, search, stats
  const [currentScreen, setCurrentScreen] = useState<string>('list'); // list, diaryDetail, diarySettings, entryEditor, appSettings
  const [isEditorFocusMode, setIsEditorFocusMode] = useState<boolean>(false);
  
  // Selected resource IDs for deep links
  const [selectedDiaryId, setSelectedDiaryId] = useState<string>('');
  const [selectedEntryId, setSelectedEntryId] = useState<string>('');
  const [selectedDate, setSelectedDate] = useState<string>('');
  const [selectedNoteId, setSelectedNoteId] = useState<string>('');
  
  // Toast notification state
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' | 'warning' } | null>(null);

  const showToast = (message: string, type: 'success' | 'error' | 'info' | 'warning' = 'success') => {
    setToast({ message, type });
  };

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => {
        setToast(null);
      }, 3500);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  // Active data states (refreshed from storage on updates)
  const [diaries, setDiaries] = useState<Diary[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [userProfile, setUserProfile] = useState<UserProfile>(() => getUserProfile());

  // Reload data from local storage helper
  const reloadData = () => {
    setDiaries(getDiaries());
    setEntries(getEntries());
    setNotes(getNotes());
    setUserProfile(getUserProfile());
  };

  const reloadTheme = () => {
    const settings = getAppSettings();
    const currentTheme = settings.theme || 'light';
    setTheme(currentTheme);
    if (currentTheme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    void syncNativeStatusBar(currentTheme);
  };

  const handleUnlock = () => {
    reloadData();
    reloadTheme();
    setIsAuthenticated(true);
  };

  // On mount: load initial state
  useEffect(() => {
    reloadData();
    reloadTheme();
    
    // Check if security PIN is enabled. If not created, let's show register PIN.
    const config = getSecurityConfig();
    if (!config.isPinCreated) {
      // If no PIN is configured, force registration
      setIsAuthenticated(false);
    } else {
      // If PIN exists, force authentication on launch
      setIsAuthenticated(false);
    }
  }, []);

  const [selectedPrompt, setSelectedPrompt] = useState<string>('');

  // Handler to navigate between tabs & sub-screens
  const handleNavigate = (
    tab: string, 
    screen: string = 'list', 
    diaryId: string = '', 
    entryId: string = '', 
    dateStr: string = '', 
    noteId: string = '',
    promptText: string = ''
  ) => {
    setActiveTab(tab);
    setCurrentScreen(screen);
    setSelectedDiaryId(diaryId);
    setSelectedEntryId(entryId);
    setSelectedDate(dateStr);
    setSelectedNoteId(noteId);
    setSelectedPrompt(promptText);
    setIsEditorFocusMode(false);
    reloadData();
    reloadTheme();
  };

  const handleBackNavigation = useCallback(() => {
    if (!isAuthenticated) {
      return;
    }

    if (isEditorFocusMode && activeTab === 'diaries' && currentScreen === 'entryEditor') {
      setIsEditorFocusMode(false);
      return;
    }

    if (activeTab === 'diaries') {
      if (currentScreen === 'diarySettings') {
        handleNavigate('diaries', 'diaryDetail', selectedDiaryId);
        return;
      }
      if (currentScreen === 'entryEditor') {
        if (selectedPrompt) {
          handleNavigate('home');
        } else if (selectedDiaryId) {
          handleNavigate('diaries', 'diaryDetail', selectedDiaryId);
        } else {
          handleNavigate('diaries', 'list');
        }
        return;
      }
      if (currentScreen === 'diaryDetail') {
        handleNavigate('diaries', 'list');
        return;
      }
    }

    if (activeTab === 'stats' && currentScreen === 'appSettings') {
      handleNavigate('stats', 'list');
      return;
    }

    if (activeTab !== 'home' || currentScreen !== 'list') {
      handleNavigate('home', 'list');
      return;
    }

    if (isAndroid()) {
      void exitNativeApp();
    }
  }, [activeTab, currentScreen, isAuthenticated, isEditorFocusMode, selectedDiaryId, selectedPrompt]);

  useEffect(() => addNativeBackListener(handleBackNavigation), [handleBackNavigation]);

  // Convert quick note into formal diary entry helper
  const handleConvertToDiaryEntry = (noteTitle: string, noteBody: string, tags: string[]) => {
    // Determine target diary (default to first diary)
    const targetDiary = diaries[0];
    if (!targetDiary) return;

    createEntry({
      diaryId: targetDiary.id,
      date: new Date().toISOString().split('T')[0],
      title: noteTitle,
      body: noteBody,
      moodName: 'Reflective',
      moodEmoji: '💭',
      tags: tags,
      photoUris: []
    });

    showToast(`Successfully converted quick note to diary entry inside "${targetDiary.name}"!`, 'success');
    handleNavigate('diaries', 'diaryDetail', targetDiary.id);
  };

  // Quick Capturing note helpers
  const handleOpenQuickNote = (noteText: string) => {
    createNote({
      title: noteText.substring(0, 24) || 'Untitled quick thought',
      body: noteText,
      isPinned: false,
      tags: ['thoughts']
    });
    showToast('Saved a quick thought to your notes!', 'success');
    handleNavigate('notes');
  };

  const handleOpenNewEntryWithPrompt = (promptText: string) => {
    const targetDiary = diaries[0];
    if (!targetDiary) return;
    
    // We navigate to entry editor in diaries tab
    handleNavigate('diaries', 'entryEditor', targetDiary.id, '', '', '', promptText);
  };

  // Render sub-screens depending on active state
  const renderContent = () => {
    switch (activeTab) {
      case 'home':
        return (
          <HomeScreen 
            diaries={diaries}
            entries={entries}
            notes={notes}
            userProfile={userProfile}
            onNavigate={handleNavigate}
            onOpenQuickNote={handleOpenQuickNote}
            onOpenNewEntryWithPrompt={handleOpenNewEntryWithPrompt}
          />
        );

      case 'diaries':
        if (currentScreen === 'diaryDetail') {
          const selectedDiary = diaries.find(d => d.id === selectedDiaryId);
          if (selectedDiary) {
            return (
              <DiaryDetailScreen 
                diary={selectedDiary}
                entries={entries}
                onBack={() => handleNavigate('diaries', 'list')}
                onEditEntry={(entryId) => handleNavigate('diaries', 'entryEditor', selectedDiaryId, entryId)}
                onNewEntry={(diaryId) => handleNavigate('diaries', 'entryEditor', diaryId)}
                onOpenSettings={(diaryId) => handleNavigate('diaries', 'diarySettings', diaryId)}
                onRefreshEntries={reloadData}
              />
            );
          }
        }

        if (currentScreen === 'diarySettings') {
          const selectedDiary = diaries.find(d => d.id === selectedDiaryId);
          if (selectedDiary) {
            return (
              <DiarySettingsScreen 
                diary={selectedDiary}
                onBack={() => handleNavigate('diaries', 'diaryDetail', selectedDiaryId)}
                onRefreshDiaries={reloadData}
              />
            );
          }
        }

        if (currentScreen === 'entryEditor') {
          return (
            <EntryEditorScreen 
              diaryId={selectedDiaryId}
              entryId={selectedEntryId}
              initialDate={selectedDate}
              initialPrompt={selectedPrompt}
              showDiarySelector={!!selectedPrompt}
              onBack={() => {
                setIsEditorFocusMode(false);
                if (selectedPrompt) {
                  handleNavigate('home');
                } else if (selectedDiaryId) {
                  handleNavigate('diaries', 'diaryDetail', selectedDiaryId);
                } else {
                  handleNavigate('diaries', 'list');
                }
              }}
              onRefreshEntries={reloadData}
              onFocusModeChange={setIsEditorFocusMode}
              initialFocusMode={isEditorFocusMode}
              onShowToast={showToast}
            />
          );
        }

        return (
          <DiariesScreen 
            diaries={diaries}
            entries={entries}
            onNavigate={handleNavigate}
            onRefreshDiaries={reloadData}
          />
        );

      case 'notes':
        return (
          <NotesScreen 
            notes={notes}
            onRefreshNotes={reloadData}
            onConvertToDiaryEntry={handleConvertToDiaryEntry}
            initialNoteId={selectedNoteId}
            onClearInitialNoteId={() => setSelectedNoteId('')}
          />
        );

      case 'search':
        return (
          <SearchScreen 
            diaries={diaries}
            entries={entries}
            notes={notes}
            onNavigate={handleNavigate}
            onEditNote={(note) => {
              // Deep-link note editing from search results
              handleNavigate('notes', 'list', '', '', '', note.id);
            }}
          />
        );

      case 'stats':
        if (currentScreen === 'appSettings') {
          return (
            <AppSettingsScreen 
              onBack={() => handleNavigate('stats', 'list')}
              onResetSuccess={() => {
                reloadData();
                handleNavigate('home');
              }}
              onShowToast={showToast}
            />
          );
        }

        return (
          <StatsScreen 
            diaries={diaries}
            entries={entries}
            notes={notes}
            userProfile={userProfile}
            onNavigate={handleNavigate}
          />
        );

      default:
        return null;
    }
  };

  // If locked, return LockScreen view
  if (!isAuthenticated) {
    return <LockScreen onUnlock={handleUnlock} />;
  }

  // If in editor focus mode, render only the editor at root level (bypasses transformed motion.div containers and options dock)
  if (isEditorFocusMode && activeTab === 'diaries' && currentScreen === 'entryEditor') {
    return (
      <div className="min-h-screen bg-brand-bg text-brand-text flex flex-col font-sans select-none relative safe-area-root">
        {/* Background Soft Ambient Light Blurs */}
        <div className="fixed inset-0 z-0 pointer-events-none opacity-20">
          <div className="absolute top-[-10%] left-[-10%] w-[60%] h-[60%] rounded-full bg-brand-blush-dark blur-[120px]" />
          <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] rounded-full bg-brand-sage-light blur-[100px]" />
        </div>
        <div className="z-10 flex-grow flex flex-col">
          {renderContent()}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-brand-bg text-brand-text flex flex-col items-center overflow-x-hidden font-sans select-none pb-24 relative safe-area-root app-shell">
      
      {/* Background Soft Ambient Light Blurs */}
      <div className="fixed inset-0 z-0 pointer-events-none opacity-20">
        <div className="absolute top-[-10%] left-[-10%] w-[60%] h-[60%] rounded-full bg-brand-blush-dark blur-[120px]" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] rounded-full bg-brand-sage-light blur-[100px]" />
      </div>

      {/* Main Container */}
      <main className="w-full max-w-lg z-10 px-4 pt-1 pb-6 flex-grow flex flex-col justify-between app-main">
        <AnimatePresence mode="wait">
          <motion.div
            key={`${activeTab}-${currentScreen}`}
            initial={{ opacity: 0, x: 10 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -10 }}
            transition={{ duration: 0.25 }}
            className="flex-grow flex flex-col justify-start"
          >
            {renderContent()}
          </motion.div>
        </AnimatePresence>
      </main>

      {/* Bottom Floating Navigation Bar */}
      {currentScreen !== 'entryEditor' && (
        <nav className="fixed bottom-4 left-4 right-4 max-w-md mx-auto bg-white/75 dark:bg-brand-card-bg/50 backdrop-blur-xl border border-brand-border/70 dark:border-white/10 rounded-3xl py-2 px-3 flex justify-between items-center z-40 shadow-[0_8px_32px_0_rgba(60,43,48,0.06),_inset_0_1px_1px_0_rgba(255,255,255,0.8)] dark:shadow-[0_8px_32px_0_rgba(0,0,0,0.3),_inset_0_1px_1px_0_rgba(255,255,255,0.05)] bottom-nav-safe">
          
          {/* Navigation Tabs */}
          <button 
            onClick={() => handleNavigate('home')}
            className={`flex flex-col items-center gap-1 flex-1 py-1 rounded-2xl transition-all ${
              activeTab === 'home' 
                ? 'text-brand-pink scale-105 font-bold' 
                : 'text-brand-sage hover:text-brand-plum'
            }`}
          >
            <Home className={`w-5 h-5 ${activeTab === 'home' ? 'stroke-[2.5px]' : ''}`} />
            <span className="text-[9px] uppercase tracking-wider">Home</span>
          </button>

          <button 
            onClick={() => handleNavigate('diaries')}
            className={`flex flex-col items-center gap-1 flex-1 py-1 rounded-2xl transition-all ${
              activeTab === 'diaries' 
                ? 'text-brand-pink scale-105 font-bold' 
                : 'text-brand-sage hover:text-brand-plum'
            }`}
          >
            <BookOpen className={`w-5 h-5 ${activeTab === 'diaries' ? 'stroke-[2.5px]' : ''}`} />
            <span className="text-[9px] uppercase tracking-wider">Diaries</span>
          </button>

          <button 
            onClick={() => handleNavigate('notes')}
            className={`flex flex-col items-center gap-1 flex-1 py-1 rounded-2xl transition-all ${
              activeTab === 'notes' 
                ? 'text-brand-pink scale-105 font-bold' 
                : 'text-brand-sage hover:text-brand-plum'
            }`}
          >
            <ClipboardList className={`w-5 h-5 ${activeTab === 'notes' ? 'stroke-[2.5px]' : ''}`} />
            <span className="text-[9px] uppercase tracking-wider">Notes</span>
          </button>

          <button 
            onClick={() => handleNavigate('search')}
            className={`flex flex-col items-center gap-1 flex-1 py-1 rounded-2xl transition-all ${
              activeTab === 'search' 
                ? 'text-brand-pink scale-105 font-bold' 
                : 'text-brand-sage hover:text-brand-plum'
            }`}
          >
            <Search className={`w-5 h-5 ${activeTab === 'search' ? 'stroke-[2.5px]' : ''}`} />
            <span className="text-[9px] uppercase tracking-wider">Search</span>
          </button>

          <button 
            onClick={() => handleNavigate('stats')}
            className={`flex flex-col items-center gap-1 flex-1 py-1 rounded-2xl transition-all ${
              activeTab === 'stats' 
                ? 'text-brand-pink scale-105 font-bold' 
                : 'text-brand-sage hover:text-brand-plum'
            }`}
          >
            <BarChart2 className={`w-5 h-5 ${activeTab === 'stats' ? 'stroke-[2.5px]' : ''}`} />
            <span className="text-[9px] uppercase tracking-wider">Stats</span>
          </button>

          <div className="w-px h-6 bg-brand-rose-light mx-1" />

          {/* Lock App Button (Interactive test action) */}
          <button 
            onClick={() => {
              setIsAuthenticated(false);
            }}
            className="p-2 text-brand-sage hover:text-brand-pink transition-all rounded-full flex items-center justify-center hover:bg-brand-blush-light active:scale-95"
            title="Secure/Lock App Now"
          >
            <Lock className="w-4 h-4" />
          </button>
        </nav>
      )}

      {/* Elegant, Non-blocking Floating Toast Notification System */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: -40, scale: 0.92, x: '-50%' }}
            animate={{ opacity: 1, y: 0, scale: 1, x: '-50%' }}
            exit={{ opacity: 0, y: -15, scale: 0.95, x: '-50%' }}
            transition={{ type: "spring", stiffness: 350, damping: 25 }}
            className="fixed top-6 left-1/2 z-50 flex items-center gap-3 bg-white/95 dark:bg-brand-card-bg/95 backdrop-blur-md px-5 py-3.5 rounded-2xl border border-brand-border/80 shadow-2xl max-w-sm w-[90%] select-none pointer-events-auto toast-safe"
          >
            <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 animate-pulse ${
              toast.type === 'success' ? 'bg-brand-sage' :
              toast.type === 'error' ? 'bg-brand-rose' : 'bg-brand-pink'
            }`} />
            
            <p className="text-xs font-bold text-brand-plum leading-snug flex-grow">
              {toast.message}
            </p>
            
            <button 
              onClick={() => setToast(null)}
              className="text-brand-text-muted hover:text-brand-rose transition-colors p-1 rounded-lg hover:bg-brand-blush-light dark:hover:bg-brand-blush-light/10"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
