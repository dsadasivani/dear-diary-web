import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react';
import {
  ArrowLeft,
  Check,
  ImagePlus,
  LayoutGrid,
  List,
  Lock,
  Plus,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react';
import type { Diary, ResponsiveLayout } from '../types';
import { PREDEFINED_COLORS } from '../domain/journalCatalog';
import { persistNativeLocalStorageItem } from '../mobile/nativeStorageBridge';
import { persistOptimizedImageFile } from '../mobile/mediaStorage';
import { triggerImpact, triggerSuccess } from '../mobile/haptics';
import { diaryRepository } from '../repositories';
import JournalCover from './JournalCover';
import {
  AppButton,
  EmptyState,
  FilterChip,
  IconButton,
  PaperSurface,
  SearchField,
  SectionHeader,
} from './UiPrimitives';
import { BottomSheet } from './ui/BottomSheet';
import { ProgressIndicator } from './ui/Feedback';
import { useAmbientTheme } from '../design/ambientTheme';

type DiaryViewMode = 'gallery' | 'list';
type DiarySort = 'updated' | 'name' | 'entries' | 'created';
type DiaryFilter = 'all' | 'locked' | 'unlocked' | 'empty';

interface DiariesScreenProps {
  diaries: Diary[];
  layout?: ResponsiveLayout;
  onNavigate: (tab: string, screen?: string, diaryId?: string, entryId?: string) => void;
  onRefreshDiaries: () => void | Promise<void>;
  onFocusedFlowChange?: (active: boolean, onBack?: () => void) => void;
}

const EMOJI_OPTIONS = ['📔', '✈️', '🌙', '🌿', '🎨', '💼', '☕', '🏠', '🔑', '📝', '🌸', '✨'];
const FOIL_ICON_OPTIONS = ['⭐', '👑', '🕊️', '🍀', '🗝️', '💎', '🌙', '☀️', '🌸', '✨', '🔥', '🪐'];
const STEP_LABELS = ['Name & privacy', 'Cover', 'Decoration', 'Review'];

export default function DiariesScreen({
  diaries,
  layout = 'mobile',
  onNavigate,
  onRefreshDiaries,
  onFocusedFlowChange,
}: DiariesScreenProps) {
  const { setAmbientContext, resetAmbientContext } = useAmbientTheme();
  const [creating, setCreating] = useState(false);
  const [creationStep, setCreationStep] = useState(0);
  const [showLibraryControls, setShowLibraryControls] = useState(false);
  const [query, setQuery] = useState('');
  const [viewMode, setViewMode] = useState<DiaryViewMode>(() =>
    localStorage.getItem('deardiary_diary_viewmode') === 'list' ? 'list' : 'gallery',
  );
  const [sortBy, setSortBy] = useState<DiarySort>('updated');
  const [filterBy, setFilterBy] = useState<DiaryFilter>('all');
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('📔');
  const [color, setColor] = useState(PREDEFINED_COLORS[0].hex);
  const [locked, setLocked] = useState(false);
  const [coverImage, setCoverImage] = useState<string>();
  const [foilIcons, setFoilIcons] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const coverInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setAmbientContext({ journalColor: color || diaries[0]?.color || null });
    return resetAmbientContext;
  }, [color, diaries, resetAmbientContext, setAmbientContext]);

  const closeCreator = useCallback(() => {
    setName('');
    setEmoji('📔');
    setColor(PREDEFINED_COLORS[0].hex);
    setLocked(false);
    setCoverImage(undefined);
    setFoilIcons([]);
    setCreationStep(0);
    setCreating(false);
  }, []);

  useEffect(() => {
    if (!creating) {
      onFocusedFlowChange?.(false);
      return;
    }
    onFocusedFlowChange?.(true, closeCreator);
    return () => onFocusedFlowChange?.(false);
  }, [closeCreator, creating, onFocusedFlowChange]);

  const visible = useMemo(
    () =>
      diaries
        .filter(
          (diary) => !query.trim() || diary.name.toLowerCase().includes(query.trim().toLowerCase()),
        )
        .filter(
          (diary) =>
            filterBy === 'all' ||
            (filterBy === 'locked' && diary.isLocked) ||
            (filterBy === 'unlocked' && !diary.isLocked) ||
            (filterBy === 'empty' && diary.entryCount === 0),
        )
        .sort((left, right) => {
          if (sortBy === 'name') return left.name.localeCompare(right.name);
          if (sortBy === 'entries') return right.entryCount - left.entryCount;
          if (sortBy === 'created') return diaries.indexOf(right) - diaries.indexOf(left);
          return (right.lastEntryUpdatedAt || 0) - (left.lastEntryUpdatedAt || 0);
        }),
    [diaries, filterBy, query, sortBy],
  );

  const latest = useMemo(
    () =>
      [...diaries].sort(
        (left, right) => (right.lastEntryUpdatedAt || 0) - (left.lastEntryUpdatedAt || 0),
      )[0],
    [diaries],
  );
  const totalEntries = diaries.reduce((sum, diary) => sum + diary.entryCount, 0);

  const setMode = (mode: DiaryViewMode) => {
    setViewMode(mode);
    localStorage.setItem('deardiary_diary_viewmode', mode);
    persistNativeLocalStorageItem('deardiary_diary_viewmode', mode);
  };

  const createJournal = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      await diaryRepository.createDiary({
        name: name.trim(),
        emoji,
        color,
        isLocked: locked,
        coverImage,
        foilIcons,
      });
      await onRefreshDiaries();
      void triggerSuccess();
      closeCreator();
    } finally {
      setSaving(false);
    }
  };

  const moveToStep = (step: number) => {
    setCreationStep(Math.min(3, Math.max(0, step)));
    window.requestAnimationFrame(() => {
      window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
      document.scrollingElement?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    });
    void triggerImpact('light');
  };

  const uploadCover = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    void persistOptimizedImageFile(file, 'cover')
      .then(setCoverImage)
      .catch((error) => console.warn('Cover image could not be attached:', error));
  };

  if (creating) {
    const preview: Diary = {
      id: 'preview',
      name: name || 'Untitled journal',
      emoji,
      color,
      isLocked: locked,
      entryCount: 0,
      lastUpdated: 'Now',
      coverImage,
      foilIcons,
    };
    return (
      <form onSubmit={createJournal} className="mx-auto w-full max-w-5xl pb-10">
        <header className="surface-glass-strong sticky top-0 z-30 -mx-1 flex items-center justify-between gap-3 rounded-[var(--radius-modal)] px-2 py-2">
          <IconButton label="Back to journals" onClick={closeCreator}>
            <ArrowLeft className="h-5 w-5" />
          </IconButton>
          <div className="min-w-0 text-center">
            <p className="app-eyebrow">Step {creationStep + 1} of 4</p>
            <h1 className="truncate font-serif-diary text-2xl font-semibold">
              {STEP_LABELS[creationStep]}
            </h1>
          </div>
          {creationStep === 3 ? (
            <AppButton type="submit" tone="primary" disabled={!name.trim() || saving}>
              {saving ? 'Creating…' : 'Create Journal'}
            </AppButton>
          ) : (
            <span className="w-11" aria-hidden="true" />
          )}
        </header>

        <ProgressIndicator
          value={creationStep + 1}
          max={4}
          label={`Journal setup: ${STEP_LABELS[creationStep]}`}
          className="mx-auto mt-5 max-w-md px-2"
        />

        <div
          className={`mt-8 grid gap-8 ${layout === 'mobile' ? '' : 'grid-cols-[minmax(210px,280px)_minmax(0,1fr)] items-start'}`}
        >
          <div
            className={`${layout === 'mobile' ? '' : 'sticky top-28'} flex flex-col items-center`}
          >
            <JournalCover diary={preview} variant="preview" className="w-44 md:w-52" />
            <p className="type-metadata mt-4 hidden max-w-52 text-center sm:block">
              Your journal stays on this device and follows your encrypted sync settings.
            </p>
          </div>

          <main className="space-y-5" aria-live="polite">
            {creationStep === 0 && (
              <PaperSurface className="space-y-5 p-5 md:p-7">
                <label className="block text-sm font-bold text-ink">
                  Journal name
                  <input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="e.g., Evening Reflections"
                    autoFocus={layout !== 'mobile'}
                    className="mt-2 min-h-12 w-full border-0 border-b border-[var(--border-strong)] bg-transparent px-0 font-serif-diary text-2xl text-ink outline-none placeholder:text-ink-tertiary focus:border-accent"
                  />
                </label>
                <label className="flex min-h-14 items-center justify-between gap-4 border-t border-[var(--border-subtle)] pt-4">
                  <span>
                    <span className="block text-sm font-bold">Private journal lock</span>
                    <span className="mt-1 block text-xs leading-relaxed text-ink-secondary">
                      Ask for PIN or biometrics when opened.
                    </span>
                  </span>
                  <input
                    type="checkbox"
                    checked={locked}
                    onChange={(event) => setLocked(event.target.checked)}
                    className="h-5 w-5 accent-brand-sage"
                  />
                </label>
              </PaperSurface>
            )}

            {creationStep === 1 && (
              <PaperSurface className="space-y-7 p-5 md:p-7">
                <div>
                  <p className="text-sm font-bold">Cover image</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <AppButton onClick={() => coverInputRef.current?.click()}>
                      <ImagePlus className="h-4 w-4" />
                      {coverImage ? 'Change image' : 'Choose image'}
                    </AppButton>
                    {coverImage && (
                      <AppButton tone="quiet" onClick={() => setCoverImage(undefined)}>
                        <Trash2 className="h-4 w-4" />
                        Remove
                      </AppButton>
                    )}
                    <input
                      ref={coverInputRef}
                      type="file"
                      accept="image/*"
                      onChange={uploadCover}
                      className="hidden"
                    />
                  </div>
                </div>
                <fieldset>
                  <legend className="text-sm font-bold">Cover color</legend>
                  <div className="mt-3 grid grid-cols-6 gap-3">
                    {PREDEFINED_COLORS.map((option) => (
                      <button
                        key={option.hex}
                        type="button"
                        aria-label={`Use ${option.name} cover color`}
                        aria-pressed={color === option.hex}
                        disabled={Boolean(coverImage)}
                        onClick={() => setColor(option.hex)}
                        className="aspect-square rounded-full border border-black/10 shadow-sm disabled:opacity-35"
                        style={{ backgroundColor: option.hex }}
                      >
                        {color === option.hex && !coverImage && (
                          <Check className="mx-auto h-5 w-5 text-white" />
                        )}
                      </button>
                    ))}
                  </div>
                </fieldset>
              </PaperSurface>
            )}

            {creationStep === 2 && (
              <PaperSurface className="space-y-7 p-5 md:p-7">
                <fieldset>
                  <legend className="text-sm font-bold">Personal emblem</legend>
                  <p className="type-supporting mt-1 hidden sm:block">
                    Choose one quiet mark for the journal spine.
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {EMOJI_OPTIONS.map((option) => (
                      <button
                        key={option}
                        type="button"
                        aria-label={`Use ${option} as journal emblem`}
                        aria-pressed={emoji === option}
                        onClick={() => setEmoji(option)}
                        className={`h-11 w-11 rounded-full text-xl ${emoji === option ? 'border-2 border-accent bg-accent-soft' : 'border border-[var(--border-subtle)] bg-surface'}`}
                      >
                        {option}
                      </button>
                    ))}
                  </div>
                </fieldset>
                <fieldset>
                  <legend className="text-sm font-bold">Foil marks ({foilIcons.length}/4)</legend>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {FOIL_ICON_OPTIONS.map((option) => {
                      const selected = foilIcons.includes(option);
                      return (
                        <button
                          key={option}
                          type="button"
                          aria-label={`${selected ? 'Remove' : 'Add'} ${option} foil mark`}
                          aria-pressed={selected}
                          onClick={() =>
                            setFoilIcons((current) =>
                              selected
                                ? current.filter((item) => item !== option)
                                : current.length < 4
                                  ? [...current, option]
                                  : current,
                            )
                          }
                          className={`h-11 w-11 rounded-full text-lg ${selected ? 'border-2 border-amber-600 bg-amber-50 text-amber-900' : 'border border-[var(--border-subtle)] bg-surface'}`}
                        >
                          {option}
                        </button>
                      );
                    })}
                  </div>
                </fieldset>
              </PaperSurface>
            )}

            {creationStep === 3 && (
              <PaperSurface className="p-5 md:p-7">
                <p className="app-eyebrow hidden sm:block">Ready for the shelf</p>
                <h2 className="mt-2 font-serif-diary text-3xl font-semibold">
                  {name || 'Untitled journal'}
                </h2>
                <dl className="mt-6 divide-y divide-[var(--border-subtle)] text-sm">
                  <div className="flex justify-between py-3">
                    <dt className="text-ink-secondary">Privacy</dt>
                    <dd className="font-bold">{locked ? 'Locked' : 'Uses app lock'}</dd>
                  </div>
                  <div className="flex justify-between py-3">
                    <dt className="text-ink-secondary">Cover</dt>
                    <dd className="font-bold">{coverImage ? 'Custom image' : 'Color cover'}</dd>
                  </div>
                  <div className="flex justify-between py-3">
                    <dt className="text-ink-secondary">Decoration</dt>
                    <dd className="font-bold">
                      {foilIcons.length ? `${foilIcons.length} foil marks` : 'Emblem only'}
                    </dd>
                  </div>
                </dl>
              </PaperSurface>
            )}

            <footer className="surface-glass-strong sticky bottom-[var(--safe-area-inset-bottom)] z-20 -mx-2 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border-subtle)] px-2 pb-2 pt-4">
              {creationStep > 0 ? (
                <AppButton onClick={() => moveToStep(creationStep - 1)}>Back</AppButton>
              ) : (
                <span />
              )}
              <div className="flex flex-wrap justify-end gap-2">
                {creationStep === 0 && (
                  <AppButton type="submit" tone="quiet" disabled={!name.trim() || saving}>
                    Create Journal
                  </AppButton>
                )}
                {creationStep < 3 && (
                  <AppButton
                    tone="primary"
                    disabled={creationStep === 0 && !name.trim()}
                    onClick={() => moveToStep(creationStep + 1)}
                  >
                    {creationStep === 0
                      ? 'Customize appearance (optional)'
                      : creationStep === 2
                        ? 'Review'
                        : 'Next'}
                  </AppButton>
                )}
                {creationStep === 3 && (
                  <AppButton type="submit" tone="primary" disabled={!name.trim() || saving}>
                    {saving ? 'Creating…' : 'Create Journal'}
                  </AppButton>
                )}
              </div>
            </footer>
          </main>
        </div>
      </form>
    );
  }

  const libraryControls = (
    <>
      <label className="block text-sm font-bold" htmlFor="journal-sort">
        Sort journals
        <select
          id="journal-sort"
          value={sortBy}
          onChange={(event) => setSortBy(event.target.value as DiarySort)}
          className="mt-2 min-h-11 w-full rounded-[var(--radius-control)] border border-[var(--border-subtle)] bg-surface px-3 text-sm font-bold"
        >
          <option value="updated">Recently updated</option>
          <option value="name">Name</option>
          <option value="entries">Most entries</option>
          <option value="created">Newest created</option>
        </select>
      </label>
      <fieldset className="mt-5">
        <legend className="text-sm font-bold">View</legend>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <AppButton
            onClick={() => setMode('gallery')}
            tone={viewMode === 'gallery' ? 'primary' : 'secondary'}
          >
            <LayoutGrid className="h-4 w-4" />
            Gallery
          </AppButton>
          <AppButton
            onClick={() => setMode('list')}
            tone={viewMode === 'list' ? 'primary' : 'secondary'}
          >
            <List className="h-4 w-4" />
            List
          </AppButton>
        </div>
      </fieldset>
    </>
  );

  return (
    <div className="space-y-7 pb-4">
      <header className="flex flex-wrap items-end justify-between gap-4">
        {layout !== 'mobile' && (
          <div>
            <h1 className="type-page-title">Your journals</h1>
            <p className="type-supporting mt-2">
              {diaries.length} private spaces · {totalEntries} entries
              {latest ? ` · Updated ${latest.lastUpdated}` : ''}
            </p>
          </div>
        )}
        <AppButton tone="primary" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" />
          New Journal
        </AppButton>
      </header>

      <section
        aria-label="Journal search and filters"
        className="space-y-3 border-y border-[var(--border-subtle)] py-4"
      >
        <div className="grid gap-3 md:grid-cols-[minmax(220px,1fr)_auto_auto]">
          <SearchField
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onClear={() => setQuery('')}
            placeholder="Find a journal"
            label="Search journals"
          />
          <AppButton className="md:hidden" onClick={() => setShowLibraryControls(true)}>
            <SlidersHorizontal className="h-4 w-4" />
            View
          </AppButton>
          <div className="hidden md:block">
            <label className="sr-only" htmlFor="journal-sort-desktop">
              Sort journals
            </label>
            <select
              id="journal-sort-desktop"
              value={sortBy}
              onChange={(event) => setSortBy(event.target.value as DiarySort)}
              className="min-h-11 rounded-[var(--radius-control)] border border-[var(--border-subtle)] bg-surface px-3 text-sm font-bold"
            >
              <option value="updated">Recently updated</option>
              <option value="name">Name</option>
              <option value="entries">Most entries</option>
              <option value="created">Newest created</option>
            </select>
          </div>
          <div className="hidden items-center rounded-[var(--radius-control)] border border-[var(--border-subtle)] p-1 md:flex">
            <IconButton
              label="Gallery view"
              aria-pressed={viewMode === 'gallery'}
              onClick={() => setMode('gallery')}
              className={viewMode === 'gallery' ? 'bg-accent-soft' : ''}
            >
              <LayoutGrid className="h-4 w-4" />
            </IconButton>
            <IconButton
              label="List view"
              aria-pressed={viewMode === 'list'}
              onClick={() => setMode('list')}
              className={viewMode === 'list' ? 'bg-accent-soft' : ''}
            >
              <List className="h-4 w-4" />
            </IconButton>
          </div>
        </div>
        <div
          className="no-scrollbar flex items-center gap-2 overflow-x-auto pb-1"
          aria-label="Filter journals"
        >
          <SlidersHorizontal
            className="mr-1 h-4 w-4 shrink-0 text-ink-tertiary"
            aria-hidden="true"
          />
          {(['all', 'locked', 'unlocked', 'empty'] as DiaryFilter[]).map((filter) => (
            <FilterChip
              key={filter}
              selected={filterBy === filter}
              onClick={() => setFilterBy(filter)}
            >
              {filter === 'all' ? 'All' : filter[0].toUpperCase() + filter.slice(1)}
            </FilterChip>
          ))}
        </div>
      </section>

      {visible.length === 0 ? (
        <EmptyState
          title="No matching journals"
          description="Try another search or filter."
          action={
            <AppButton tone="primary" onClick={() => setCreating(true)}>
              New Journal
            </AppButton>
          }
        />
      ) : viewMode === 'list' ? (
        <section
          aria-label="Journal list"
          className="divide-y divide-[var(--border-subtle)] border-y border-[var(--border-subtle)]"
        >
          {visible.map((diary) => (
            <button
              key={diary.id}
              type="button"
              data-testid="diary-card"
              onClick={() => {
                void triggerImpact('light');
                onNavigate('diaries', 'diaryDetail', diary.id);
              }}
              className="group flex w-full items-center gap-4 px-1 py-4 text-left hover:bg-surface-subtle/60"
            >
              <JournalCover diary={diary} variant="thumbnail" showTitle={false} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-serif-diary text-xl font-semibold">
                  {diary.name}
                </span>
                <span className="type-metadata mt-1 block">
                  {diary.entryCount} entries · {diary.lastUpdated}
                </span>
              </span>
              {diary.isLocked && (
                <span className="flex items-center gap-1 text-xs font-semibold text-ink-secondary">
                  <Lock className="h-4 w-4" />
                  Locked
                </span>
              )}
            </button>
          ))}
        </section>
      ) : (
        <section aria-label="Journal gallery">
          <SectionHeader
            eyebrow={layout === 'desktop' ? 'Library' : undefined}
            title={query || filterBy !== 'all' ? 'Matching journals' : 'On your shelf'}
            className="mb-5"
          />
          <div className="grid grid-cols-2 gap-x-5 gap-y-8 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">
            {visible.map((diary) => (
              <button
                key={diary.id}
                type="button"
                data-testid="diary-card"
                onClick={() => {
                  void triggerImpact('light');
                  onNavigate('diaries', 'diaryDetail', diary.id);
                }}
                className="group min-w-0 text-left"
              >
                <JournalCover
                  diary={diary}
                  variant="full"
                  showTitle={false}
                  className="w-full transition-transform duration-200 group-hover:-translate-y-1 group-focus-visible:-translate-y-1"
                />
                <span className="mt-3 flex items-start justify-between gap-2">
                  <span className="min-w-0">
                    <span className="block truncate font-serif-diary text-lg font-semibold text-ink">
                      {diary.name}
                    </span>
                    <span className="type-metadata mt-0.5 block">
                      {diary.entryCount} entries
                      {layout !== 'mobile' && ` · ${diary.lastUpdated}`}
                    </span>
                  </span>
                  {diary.isLocked && (
                    <Lock
                      className="mt-1 h-3.5 w-3.5 shrink-0 text-ink-tertiary"
                      aria-label="Locked journal"
                    />
                  )}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      <BottomSheet
        open={showLibraryControls}
        title="Sort and view"
        onClose={() => setShowLibraryControls(false)}
        footer={
          <AppButton tone="primary" onClick={() => setShowLibraryControls(false)}>
            Done
          </AppButton>
        }
      >
        {libraryControls}
      </BottomSheet>
    </div>
  );
}
