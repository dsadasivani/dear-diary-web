import {
  ArrowLeft,
  BarChart2,
  BookOpen,
  ClipboardList,
  Home,
  Lock,
  Plus,
  Search,
  Settings,
} from 'lucide-react';
import ProfileAvatar from './ProfileAvatar';
import type { UserProfile } from '../types';
import { BottomSheet } from './ui/BottomSheet';
import { motion, useReducedMotion } from 'motion/react';
import { triggerImpact } from '../mobile/haptics';
import { motionTransitions } from './ui/motion';

export type PrimaryDestination = 'home' | 'diaries' | 'notes' | 'stats';

const primaryDestinationIds: readonly string[] = ['home', 'diaries', 'notes', 'stats'];

export const isRootDestinationScreen = (activeTab: string, currentScreen: string): boolean =>
  currentScreen === 'list' && primaryDestinationIds.includes(activeTab);

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
  const reducedMotion = useReducedMotion();
  const first = destinations.slice(0, 2);
  const last = destinations.slice(2);
  const renderItem = ({ id, label, icon: Icon, testId }: (typeof destinations)[number]) => {
    const selected = active === id;
    return (
      <button
        key={id}
        type="button"
        data-testid={testId}
        aria-current={selected ? 'page' : undefined}
        aria-label={label}
        onClick={() => {
          if (!selected) void triggerImpact('light');
          onNavigate(id);
        }}
        className={`app-nav-item ${selected ? 'app-nav-item-active' : ''}`}
      >
        {selected && (
          <motion.span
            layoutId="mobile-primary-selection"
            aria-hidden="true"
            className="app-nav-selection"
            transition={reducedMotion ? { duration: 0.01 } : motionTransitions.sharedObject}
          />
        )}
        <span className="app-nav-icon" aria-hidden="true">
          <Icon className="h-[1.15rem] w-[1.15rem]" />
        </span>
        <span className="app-nav-label">{label}</span>
      </button>
    );
  };

  return (
    <nav aria-label="Primary" className="mobile-bottom-navigation bottom-nav-safe">
      {first.map(renderItem)}
      <button
        type="button"
        onClick={() => {
          void triggerImpact('light');
          onCreate();
        }}
        className="app-create-button"
        aria-label="Create"
      >
        <span className="app-create-icon" aria-hidden="true">
          <Plus className="h-5 w-5" />
        </span>
        <span className="app-nav-label">New</span>
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

export function NavigationRail({
  active,
  onNavigate,
  onCreate,
  onSearch,
  onSettings,
  onLock,
}: RailProps) {
  return (
    <aside className="navigation-rail" aria-label="Application navigation">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-sage text-white">
        <BookOpen />
      </div>
      <nav aria-label="Primary" className="mt-6 flex flex-1 flex-col gap-2">
        {destinations.map(({ id, label, icon: Icon, testId }) => (
          <button
            key={id}
            type="button"
            data-testid={testId}
            aria-current={active === id ? 'page' : undefined}
            onClick={() => onNavigate(id)}
            className={`rail-item ${active === id ? 'rail-item-active' : ''}`}
          >
            <Icon className="h-5 w-5" />
            <span>{label}</span>
          </button>
        ))}
        <button
          type="button"
          onClick={onCreate}
          className="rail-item rail-create mt-2 bg-brand-sage hover:bg-brand-sage-dark"
        >
          <Plus className="h-5 w-5" />
          <span>Create</span>
        </button>
      </nav>
      <div className="flex flex-col gap-2 border-t border-brand-border pt-3">
        <button type="button" onClick={onSearch} className="rail-item">
          <Search className="h-5 w-5" />
          <span>Search</span>
        </button>
        <button type="button" onClick={onSettings} className="rail-item">
          <Settings className="h-5 w-5" />
          <span>Settings</span>
        </button>
        <button type="button" onClick={onLock} className="rail-item">
          <Lock className="h-5 w-5" />
          <span>Lock</span>
        </button>
      </div>
    </aside>
  );
}

interface AppHeaderProps {
  title: string;
  profile: UserProfile;
  onSearch: () => void;
  onProfile: () => void;
  onBack?: () => void;
}

export function AppHeader({ title, profile, onSearch, onProfile, onBack }: AppHeaderProps) {
  return (
    <header className={`app-header ${onBack ? 'app-header-with-back' : ''}`}>
      <div className="app-header-leading">
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            className="app-header-action app-header-back"
            aria-label="Back to Today"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
        ) : null}
        <div className="app-header-copy">
          <p className="app-header-eyebrow">
            {!onBack && (
              <BookOpen className="app-header-eyebrow-icon" strokeWidth={2.1} aria-hidden="true" />
            )}
            <span>Dear Diary</span>
          </p>
          <h1 className="app-header-title">{title}</h1>
        </div>
      </div>
      <div className="app-header-actions">
        {!onBack && (
          <button
            type="button"
            data-testid="nav-search"
            onClick={onSearch}
            className="app-header-action"
            aria-label="Search"
          >
            <Search className="h-5 w-5" />
          </button>
        )}
        <button
          type="button"
          data-testid="profile-menu-button"
          onClick={onProfile}
          className="app-header-action app-header-profile"
          aria-label="Open profile and settings"
          style={{ backgroundColor: profile.avatarColor }}
        >
          <ProfileAvatar profile={profile} />
        </button>
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

export function ProfileActionSheet({
  open,
  profile,
  onClose,
  onSettings,
  onLock,
}: ProfileActionSheetProps) {
  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={profile.name}
      label="Profile menu"
      className="md:max-w-sm"
    >
      <div className="grid gap-1">
        <button
          type="button"
          onClick={() => {
            onSettings();
            onClose();
          }}
          className="flex min-h-12 items-center gap-3 rounded-[var(--radius-control)] px-3 text-sm font-bold hover:bg-surface-subtle"
        >
          <Settings className="h-5 w-5" />
          Settings
        </button>
        <button
          type="button"
          data-testid="lock-app-button"
          onClick={() => {
            onLock();
            onClose();
          }}
          className="flex min-h-12 items-center gap-3 rounded-[var(--radius-control)] px-3 text-sm font-bold hover:bg-surface-subtle"
        >
          <Lock className="h-5 w-5" />
          Lock Dear Diary
        </button>
      </div>
    </BottomSheet>
  );
}

export function CreateActionSheet({
  open,
  hasJournals,
  onClose,
  onNewEntry,
  onNewNote,
  onVoice,
  onPhoto,
  onNewJournal,
}: CreateActionSheetProps) {
  const actions = [
    {
      label: 'New Journal Entry',
      onClick: onNewEntry,
      disabled: !hasJournals,
    },
    { label: 'Quick Note', onClick: onNewNote },
    {
      label: 'Voice Reflection',
      onClick: onVoice,
      disabled: !hasJournals,
    },
    {
      label: 'Photo Memory',
      onClick: onPhoto,
      disabled: !hasJournals,
    },
    { label: 'New Journal', onClick: onNewJournal },
  ];
  return (
    <BottomSheet open={open} onClose={onClose} title="Create" className="md:max-w-md">
      <div className="grid gap-1">
        {actions.map((action) => (
          <button
            key={action.label}
            type="button"
            disabled={action.disabled}
            onClick={() => {
              action.onClick();
              onClose();
            }}
            className="group flex min-h-14 items-center justify-between rounded-[var(--radius-control)] px-3 py-3 text-left transition-colors hover:bg-surface-subtle disabled:opacity-45"
          >
            <span>
              <span className="block text-sm font-bold">{action.label}</span>
              {action.disabled && (
                <span className="block text-xs text-ink-secondary">Create a journal first</span>
              )}
            </span>
            <Plus className="h-4 w-4 text-ink-tertiary transition-transform group-hover:rotate-90" />
          </button>
        ))}
      </div>
    </BottomSheet>
  );
}
