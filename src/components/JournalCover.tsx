import React from 'react';
import { Lock } from 'lucide-react';
import type { Diary } from '../types';

interface JournalCoverProps {
  diary: Pick<Diary, 'name' | 'emoji' | 'color' | 'coverImage' | 'foilIcons' | 'isLocked'>;
  variant?: 'full' | 'thumbnail' | 'preview';
  className?: string;
  showTitle?: boolean;
}

export default function JournalCover({ diary, variant = 'thumbnail', className = '', showTitle = true }: JournalCoverProps) {
  const full = variant === 'full';
  const preview = variant === 'preview';
  return (
    <div
      className={`relative overflow-hidden border border-black/10 shadow-sm ${full || preview ? 'aspect-[3/4.2] rounded-[22px]' : 'h-14 w-11 rounded-xl'} ${className}`}
      style={{
        backgroundColor: diary.color,
        backgroundImage: diary.coverImage ? `linear-gradient(rgba(20,12,15,.08),rgba(20,12,15,.22)),url(${diary.coverImage})` : undefined,
        backgroundPosition: 'center',
        backgroundSize: 'cover',
      }}
      aria-hidden="true"
    >
      {(full || preview) && <span className="absolute inset-y-0 left-0 w-3 bg-gradient-to-r from-black/25 to-transparent" />}
      <div className={`relative flex h-full flex-col justify-between ${full || preview ? 'p-4' : 'p-1.5'}`}>
        <div className="flex items-start justify-between gap-1">
          <span className={`flex items-center justify-center bg-white/90 shadow-sm ${full || preview ? 'h-9 w-9 rounded-xl text-lg' : 'h-6 w-6 rounded-md text-sm'}`}>{diary.emoji}</span>
          {diary.isLocked && <span className="rounded-md bg-black/25 p-1 text-white"><Lock className={full || preview ? 'h-4 w-4' : 'h-3 w-3'} /></span>}
        </div>
        {(full || preview) && diary.foilIcons && diary.foilIcons.length > 0 && (
          <div className="flex flex-wrap gap-1 text-sm text-amber-200 drop-shadow">{diary.foilIcons.slice(0, 4).map((icon, index) => <span key={`${icon}-${index}`}>{icon}</span>)}</div>
        )}
        {showTitle && (full || preview) && (
          <div className="rounded-xl bg-white/92 p-2.5 shadow-sm">
            <p className="truncate font-serif-diary text-sm font-bold text-brand-plum">{diary.name || 'Untitled journal'}</p>
          </div>
        )}
      </div>
    </div>
  );
}
