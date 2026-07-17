import React, { useEffect, useRef } from 'react';
import { BarChart2, BookOpen, ClipboardList, Home, Lock, Plus, Search, Settings, X } from 'lucide-react';
import OverlayPortal from './OverlayPortal';
import ProfileAvatar from './ProfileAvatar';
import type { UserProfile } from '../types';

export type PrimaryDestination = 'home' | 'diaries' | 'notes' | 'stats';

const destinations = [
  { id: 'home' as const, label: 'Today', icon: Home, testId: 'nav-home' },
  { id: 'diaries' as const, label: 'Journals', icon: BookOpen, testId: 'nav-diaries' },
  { id: 'notes' as const, label: 'Notes', icon: ClipboardList, testId: 'nav-notes' },
  { id: 'stats' as const, label: 'Insights', icon: BarChart2, testId: 'nav-stats' },
];

interface NavigationProps {
  active: string;
  onNavigate: (destination: PrimaryDestination) => void;
  onCreate: () => void;
}

export function MobileBottomNavigation({ active, onNavigate, onCreate }: NavigationProps) {
  const first = destinations.slice(0, 2);
  const last = destinations.slice(2);
  const renderItem = ({ id, label, icon: Icon, testId }: typeof destinations[number]) => {
    const selected = active === id;
    return (
      <button
        key={id}
        type="button"
        data-testid={testId}
        aria-current={selected ? 'page' : undefined}
        aria-label={label}
        onClick={() => onNavigate(id)}
        className={`app-nav-item ${selected ? 'app-nav-item-active' : ''}`}
      >
        <Icon aria-hidden="true" className="h-5 w-5" />
        <span>{label}</span>
      </button>
    );
  };

  return (
    <nav aria-label="Primary" className="mobile-bottom-navigation bottom-nav-safe">
      {first.map(renderItem)}
      <button type="button" onClick={onCreate} className="app-create-button" aria-label="Create">
        <Plus aria-hidden="true" className="h-6 w-6" />
        <span>Create</span>
      </button>
      {last.map(renderItem)}
    </nav>
  );
}

interface RailProps extends NavigationProps {
  onSearch: () => void;
  onSettings: () => void;
  onLock: () => void;
}

export function NavigationRail({ active, onNavigate, onCreate, onSearch, onSettings, onLock }: RailProps) {
  return (
    <aside className="navigation-rail" aria-label="Application navigation">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-sage text-white"><BookOpen /></div>
      <nav aria-label="Primary" className="mt-6 flex flex-1 flex-col gap-2">
        {destinations.map(({ id, label, icon: Icon, testId }) => (
          <button key={id} type="button" data-testid={testId} aria-current={active === id ? 'page' : undefined} onClick={() => onNavigate(id)} className={`rail-item ${active === id ? 'rail-item-active' : ''}`}>
            <Icon className="h-5 w-5" /><span>{label}</span>
          </button>
        ))}
        <button type="button" onClick={onCreate} className="rail-item rail-create mt-2 bg-brand-sage hover:bg-brand-sage-dark"><Plus className="h-5 w-5" /><span>Create</span></button>
      </nav>
      <div className="flex flex-col gap-2 border-t border-brand-border pt-3">
        <button type="button" onClick={onSearch} className="rail-item"><Search className="h-5 w-5" /><span>Search</span></button>
        <button type="button" onClick={onSettings} className="rail-item"><Settings className="h-5 w-5" /><span>Settings</span></button>
        <button type="button" onClick={onLock} className="rail-item"><Lock className="h-5 w-5" /><span>Lock</span></button>
      </div>
    </aside>
  );
}

interface AppHeaderProps {
  title: string;
  profile: UserProfile;
  onSearch: () => void;
  onProfile: () => void;
}

export function AppHeader({ title, profile, onSearch, onProfile }: AppHeaderProps) {
  return (
    <header className="app-header">
      <div className="min-w-0">
        <p className="app-eyebrow">Dear Diary</p>
        <h1 className="truncate font-serif-diary text-2xl font-semibold text-brand-plum dark:text-brand-text">{title}</h1>
      </div>
      <div className="flex items-center gap-2">
        <button type="button" data-testid="nav-search" onClick={onSearch} className="icon-button" aria-label="Search"><Search className="h-5 w-5" /></button>
        <button type="button" data-testid="profile-menu-button" onClick={onProfile} className="icon-button overflow-hidden" aria-label="Open profile and settings" style={{ backgroundColor: profile.avatarColor }}><ProfileAvatar profile={profile} /></button>
      </div>
    </header>
  );
}

interface CreateActionSheetProps {
  open: boolean;
  hasJournals: boolean;
  onClose: () => void;
  onNewEntry: () => void;
  onNewNote: () => void;
  onVoice: () => void;
  onPhoto: () => void;
  onNewJournal: () => void;
}

interface ProfileActionSheetProps {
  open: boolean;
  profile: UserProfile;
  onClose: () => void;
  onSettings: () => void;
  onLock: () => void;
}

export function ProfileActionSheet({ open, profile, onClose, onSettings, onLock }: ProfileActionSheetProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); previous?.focus(); };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <OverlayPortal>
      <div className="fixed inset-0 z-[110] flex items-end justify-center bg-black/35 p-3 backdrop-blur-sm md:items-center" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
        <section role="dialog" aria-modal="true" aria-label="Profile menu" className="surface-modal w-full max-w-sm p-4 mobile-overlay-safe">
          <div className="flex items-center gap-3 border-b border-brand-border px-1 pb-4">
            <span className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-full" style={{ backgroundColor: profile.avatarColor }}><ProfileAvatar profile={profile} /></span>
            <div className="min-w-0 flex-1"><p className="truncate text-sm font-bold">{profile.name}</p><p className="text-xs text-brand-text-muted">Your private journal space</p></div>
            <button ref={closeRef} type="button" onClick={onClose} className="icon-button" aria-label="Close profile menu"><X className="h-5 w-5" /></button>
          </div>
          <div className="grid gap-2 pt-3">
            <button type="button" onClick={() => { onSettings(); onClose(); }} className="flex min-h-12 items-center gap-3 rounded-xl px-3 text-sm font-bold hover:bg-brand-sage-light"><Settings className="h-5 w-5" />Settings</button>
            <button type="button" data-testid="lock-app-button" onClick={() => { onLock(); onClose(); }} className="flex min-h-12 items-center gap-3 rounded-xl px-3 text-sm font-bold hover:bg-brand-sage-light"><Lock className="h-5 w-5" />Lock Dear Diary</button>
          </div>
        </section>
      </div>
    </OverlayPortal>
  );
}

export function CreateActionSheet({ open, hasJournals, onClose, onNewEntry, onNewNote, onVoice, onPhoto, onNewJournal }: CreateActionSheetProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key !== 'Tab') return;
      const focusable: HTMLElement[] = dialogRef.current
        ? Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, textarea, [tabindex]:not([tabindex="-1"])'))
        : [];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); previous?.focus(); };
  }, [open, onClose]);
  if (!open) return null;
  const actions = [
    { label: 'New Journal Entry', detail: 'Write in a journal', onClick: onNewEntry, disabled: !hasJournals },
    { label: 'Quick Note', detail: 'Capture a thought', onClick: onNewNote },
    { label: 'Voice Reflection', detail: 'Record in a new entry', onClick: onVoice, disabled: !hasJournals },
    { label: 'Photo Memory', detail: 'Add a photo to a new entry', onClick: onPhoto, disabled: !hasJournals },
    { label: 'New Journal', detail: 'Create a private space', onClick: onNewJournal },
  ];
  return (
    <OverlayPortal>
      <div className="fixed inset-0 z-[110] flex items-end justify-center bg-black/35 p-3 backdrop-blur-sm md:items-center" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
        <section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="create-sheet-title" className="surface-modal w-full max-w-md p-4 mobile-overlay-safe">
          <div className="flex items-center justify-between px-1 pb-3">
            <div><p className="app-eyebrow">Create</p><h2 id="create-sheet-title" className="font-serif-diary text-2xl font-semibold">What would you like to capture?</h2></div>
            <button ref={closeRef} type="button" onClick={onClose} className="icon-button" aria-label="Close create menu"><X className="h-5 w-5" /></button>
          </div>
          <div className="grid gap-2">
            {actions.map(action => <button key={action.label} type="button" disabled={action.disabled} onClick={() => { action.onClick(); onClose(); }} className="flex min-h-14 items-center justify-between rounded-xl border border-brand-border bg-brand-bg/45 px-4 py-3 text-left transition hover:border-brand-sage disabled:opacity-45"><span><span className="block text-sm font-bold">{action.label}</span><span className="block text-xs text-brand-text-muted">{action.disabled ? 'Create a journal first' : action.detail}</span></span><Plus className="h-4 w-4" /></button>)}
          </div>
        </section>
      </div>
    </OverlayPortal>
  );
}
