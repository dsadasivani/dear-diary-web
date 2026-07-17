import React, { useMemo, useRef, useState } from 'react';
import { ArrowLeft, ImagePlus, Lock, RotateCcw, Save, Trash2 } from 'lucide-react';
import type { Diary, Entry, ResponsiveLayout, SecurityConfig } from '../types';
import { PREDEFINED_COLORS } from '../domain/journalCatalog';
import { verifyPin } from '../domain/security';
import { persistOptimizedImageFile } from '../mobile/mediaStorage';
import { diaryRepository } from '../repositories';
import JournalCover from './JournalCover';
import { AppButton, AppDialog, IconButton, StatusNotice } from './UiPrimitives';

interface DiarySettingsScreenProps {
  diary: Diary;
  layout?: ResponsiveLayout;
  security: SecurityConfig;
  onBack: () => void;
  onRefreshDiaries: () => void | Promise<void>;
}

const EMOJIS = ['📔', '✈️', '💼', '🌙', '🎨', '🌿', '☕', '🏠', '🔑', '📝', '🌸', '✨'];
const FOILS = ['⭐', '👑', '🕊️', '🍀', '🗝️', '💎', '🌙', '☀️', '🌸', '✨'];

export default function DiarySettingsScreen({ diary, layout = 'mobile', security, onBack, onRefreshDiaries }: DiarySettingsScreenProps) {
  const original = useMemo(() => ({ name: diary.name, emoji: diary.emoji, color: diary.color, isLocked: diary.isLocked, coverImage: diary.coverImage, foilIcons: diary.foilIcons || [] }), [diary]);
  const [draft, setDraft] = useState(original);
  const [appearanceOpen, setAppearanceOpen] = useState(layout !== 'mobile');
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [counts, setCounts] = useState({ entries: 0, photos: 0, audio: 0 });
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const coverInput = useRef<HTMLInputElement>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(original);

  const requestBack = () => dirty ? setLeaveOpen(true) : onBack();
  const save = async () => {
    if (!draft.name.trim() || !dirty) return;
    setBusy(true);
    await diaryRepository.updateDiary({ ...diary, ...draft, name: draft.name.trim() });
    await onRefreshDiaries();
    setBusy(false);
    onBack();
  };

  const openDelete = async () => {
    setBusy(true);
    let cursor: string | undefined;
    let entries = 0, photos = 0, audio = 0;
    do {
      const page = await diaryRepository.listEntriesByDiary(diary.id, { cursor, limit: 200, includeBody: true });
      for (const item of page.items as Entry[]) {
        entries += 1;
        photos += item.photoUris?.length || item.photoCount || 0;
        audio += (item.audioUri ? 1 : 0) + (item.blocks?.filter(block => Boolean(block.audioUri)).length || 0);
      }
      cursor = page.nextCursor;
    } while (cursor);
    setCounts({ entries, photos, audio });
    setPin(''); setError(''); setDeleteOpen(true); setBusy(false);
  };

  const remove = async () => {
    const requiresPin = diary.isLocked || counts.entries > 0;
    if (requiresPin && !verifyPin(security, pin)) { setError('Incorrect app PIN.'); return; }
    setBusy(true);
    await diaryRepository.deleteDiary(diary.id);
    await onRefreshDiaries();
    onBack();
  };

  const chooseCover = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    try {
      const coverImage = await persistOptimizedImageFile(file, 'cover');
      setDraft(current => ({ ...current, coverImage }));
    }
    catch (cause: any) { setError(cause?.message || 'Cover image could not be saved.'); }
    finally { setBusy(false); }
  };

  const previewDiary: Diary = { ...diary, ...draft };
  return <div className="mx-auto w-full max-w-6xl space-y-5 pb-12">
    <header className="sticky top-0 z-30 flex items-center justify-between border-b border-brand-border bg-brand-bg/95 py-3 backdrop-blur">
      <div className="flex items-center gap-3"><IconButton label="Back from journal settings" onClick={requestBack}><ArrowLeft className="h-5 w-5" /></IconButton><div><h1 className="font-serif-diary text-2xl font-semibold">Journal Settings</h1>{dirty && <p role="status" className="text-xs font-bold text-amber-700">Unsaved changes</p>}</div></div>
      <AppButton tone="primary" onClick={() => void save()} disabled={!dirty || !draft.name.trim() || busy}><Save className="h-4 w-4" />Save</AppButton>
    </header>

    <div className={layout === 'mobile' ? 'space-y-5' : 'grid grid-cols-[minmax(0,1fr)_320px] gap-8'}>
      <div className="space-y-5">
        <section className="surface-elevated space-y-4 p-5"><h2 className="font-serif-diary text-xl font-semibold">Name and privacy</h2><label className="block text-sm font-bold">Journal name<input value={draft.name} onChange={event => setDraft(current => ({ ...current, name: event.target.value }))} className="mt-2 w-full rounded-xl border border-brand-border bg-brand-card-bg px-4 py-3 text-base" /></label><label className="flex min-h-11 items-center gap-3 text-sm font-bold"><input type="checkbox" checked={draft.isLocked} onChange={event => setDraft(current => ({ ...current, isLocked: event.target.checked }))} className="h-5 w-5" /><Lock className="h-4 w-4" />Require unlock before opening</label></section>
        <section className="surface-elevated p-5"><button type="button" aria-expanded={appearanceOpen} onClick={() => setAppearanceOpen(value => !value)} className="flex w-full items-center justify-between text-left"><span><span className="block font-serif-diary text-xl font-semibold">Appearance</span><span className="text-xs text-brand-text-muted">Cover, color, emoji, and foil</span></span><span>{appearanceOpen ? 'Hide' : 'Edit'}</span></button>{appearanceOpen && <div className="mt-5 space-y-5">
          {layout === 'mobile' && <JournalCover diary={previewDiary} variant="preview" />}
          <div><p className="mb-2 text-sm font-bold">Cover image</p><input ref={coverInput} type="file" accept="image/*" className="sr-only" onChange={event => void chooseCover(event.target.files?.[0])} /><div className="flex flex-wrap gap-2"><AppButton onClick={() => coverInput.current?.click()}><ImagePlus className="h-4 w-4" />{draft.coverImage ? 'Change image' : 'Choose image'}</AppButton>{draft.coverImage && <AppButton tone="quiet" onClick={() => setDraft(current => ({ ...current, coverImage: undefined }))}>Remove image</AppButton>}</div></div>
          <div><p className="mb-2 text-sm font-bold">Color</p><div className="flex flex-wrap gap-2">{PREDEFINED_COLORS.map(color => <button type="button" key={color.hex} aria-label={color.name} aria-pressed={draft.color === color.hex} onClick={() => setDraft(current => ({ ...current, color: color.hex }))} className="h-11 w-11 rounded-full border-4" style={{ backgroundColor: color.hex, borderColor: draft.color === color.hex ? '#111' : 'transparent' }} />)}</div></div>
          <div><p className="mb-2 text-sm font-bold">Symbol</p><div className="flex flex-wrap gap-2">{EMOJIS.map(emoji => <button type="button" key={emoji} aria-label={`Use ${emoji}`} aria-pressed={draft.emoji === emoji} onClick={() => setDraft(current => ({ ...current, emoji }))} className={`rounded-xl border text-xl ${draft.emoji === emoji ? 'border-brand-sage bg-brand-sage-light' : 'border-brand-border'}`}>{emoji}</button>)}</div></div>
          <div><p className="mb-2 text-sm font-bold">Foil details (up to four)</p><div className="flex flex-wrap gap-2">{FOILS.map(icon => <button type="button" key={icon} aria-pressed={draft.foilIcons.includes(icon)} onClick={() => setDraft(current => ({ ...current, foilIcons: current.foilIcons.includes(icon) ? current.foilIcons.filter(item => item !== icon) : current.foilIcons.length < 4 ? [...current.foilIcons, icon] : current.foilIcons }))} className={`rounded-xl border text-lg ${draft.foilIcons.includes(icon) ? 'border-brand-sage bg-brand-sage-light' : 'border-brand-border'}`}>{icon}</button>)}</div></div>
          <AppButton onClick={() => setDraft(current => ({ ...current, emoji: '📔', color: PREDEFINED_COLORS[0].hex, coverImage: undefined, foilIcons: [] }))}><RotateCcw className="h-4 w-4" />Restore appearance defaults</AppButton>
        </div>}</section>
        <section className="rounded-2xl border border-red-300 bg-red-50/70 p-5 dark:bg-red-950/20"><h2 className="font-serif-diary text-xl font-semibold text-red-800 dark:text-red-200">Delete journal</h2><p className="mt-2 text-sm text-red-700 dark:text-red-200">Deletes this journal and its downloaded entries and media from this device. If Sync is connected, deletion is also synchronized.</p><AppButton className="mt-4" tone="danger" onClick={() => void openDelete()} disabled={busy}><Trash2 className="h-4 w-4" />Review deletion</AppButton></section>
        {error && <StatusNotice tone="danger" role="alert">{error}</StatusNotice>}
      </div>
      {layout !== 'mobile' && <aside className="sticky top-24 h-fit"><JournalCover diary={previewDiary} variant="preview" /><p className="mt-3 text-center text-xs text-brand-text-muted">Preview updates before you save.</p></aside>}
    </div>

    <AppDialog open={leaveOpen} title="Discard unsaved changes?" description="Your journal settings have changed." onClose={() => setLeaveOpen(false)} footer={<><AppButton onClick={() => setLeaveOpen(false)}>Keep editing</AppButton><AppButton tone="danger" onClick={onBack}>Discard changes</AppButton></>}><p className="text-sm text-brand-text-muted">Save first if you want to keep the new name, lock, or appearance.</p></AppDialog>
    <AppDialog open={deleteOpen} title={`Delete ${diary.name}?`} description="Review exactly what will be removed before continuing." onClose={() => setDeleteOpen(false)} footer={<><AppButton onClick={() => setDeleteOpen(false)}>Cancel</AppButton><AppButton tone="danger" onClick={() => void remove()} disabled={busy}>Delete journal</AppButton></>}>
      <StatusNotice tone="warning">{counts.entries} entries · {counts.photos} photos · {counts.audio} audio recordings</StatusNotice>{(diary.isLocked || counts.entries > 0) && <label className="mt-4 block text-sm font-bold">App PIN<input type="password" inputMode="numeric" value={pin} onChange={event => { setPin(event.target.value); setError(''); }} className="mt-2 w-full rounded-xl border border-brand-border bg-brand-card-bg px-4 py-3" /></label>}{error && <StatusNotice className="mt-3" tone="danger" role="alert">{error}</StatusNotice>}
    </AppDialog>
  </div>;
}
