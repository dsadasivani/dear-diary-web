import {
  BookHeart,
  Feather,
  Flower2,
  KeyRound,
  Leaf,
  Lock,
  MoonStar,
  Mountain,
  Palette,
  Plane,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import type { CSSProperties } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import type { Diary } from '../types';
import { motionTransitions } from './ui/motion';

interface JournalCoverProps {
  diary: Pick<Diary, 'name' | 'emoji' | 'color' | 'coverImage' | 'foilIcons' | 'isLocked'> &
    Partial<Pick<Diary, 'id'>>;
  variant?: 'full' | 'thumbnail' | 'preview';
  className?: string;
  showTitle?: boolean;
}

const EMBLEMS: LucideIcon[] = [
  BookHeart,
  Feather,
  Leaf,
  MoonStar,
  Flower2,
  Plane,
  Palette,
  Mountain,
  KeyRound,
];
const FOIL_MARKS: LucideIcon[] = [Sparkles, MoonStar, Flower2, Leaf];

const emblemFor = (diary: JournalCoverProps['diary']): LucideIcon => {
  const source = `${diary.emoji || ''}${diary.name || ''}`;
  const hash = Array.from(source).reduce(
    (sum, character) => sum + (character.codePointAt(0) || 0),
    0,
  );
  return EMBLEMS[hash % EMBLEMS.length];
};

export default function JournalCover({
  diary,
  variant = 'thumbnail',
  className = '',
  showTitle = true,
}: JournalCoverProps) {
  const reducedMotion = useReducedMotion();
  const large = variant === 'full' || variant === 'preview';
  const Emblem = emblemFor(diary);
  const foilCount = Math.min(4, diary.foilIcons?.length || 0);

  return (
    <motion.div
      layoutId={diary.id ? `journal-cover-${diary.id}` : undefined}
      transition={reducedMotion ? { duration: 0.01 } : motionTransitions.sharedObject}
      whileTap={reducedMotion ? undefined : { scale: 0.985 }}
      className={`relative isolate overflow-hidden border border-black/15 bg-[var(--cover-color)] text-white shadow-[0_16px_36px_rgba(37,22,27,0.16),inset_1px_0_rgba(255,255,255,0.18)] ${large ? 'aspect-[3/4.35] rounded-[0.7rem_1.15rem_1.15rem_0.7rem]' : 'h-16 w-12 rounded-[0.35rem_0.65rem_0.65rem_0.35rem]'} ${className}`}
      style={
        {
          '--cover-color': diary.color,
          backgroundColor: diary.color,
          backgroundImage: diary.coverImage
            ? `linear-gradient(155deg,rgba(24,14,18,.08),rgba(24,14,18,.5)),url(${diary.coverImage})`
            : `linear-gradient(145deg,color-mix(in srgb,${diary.color} 82%,white),${diary.color} 52%,color-mix(in srgb,${diary.color} 76%,black))`,
          backgroundPosition: 'center',
          backgroundSize: 'cover',
        } as CSSProperties
      }
      aria-hidden="true"
    >
      <span
        className={`absolute inset-y-0 left-0 ${large ? 'w-4' : 'w-2'} bg-gradient-to-r from-black/30 via-black/8 to-white/8`}
      />
      <span className="absolute inset-y-0 right-0 w-px bg-white/25" />
      <span className="absolute inset-x-0 top-0 h-px bg-white/35" />
      {!diary.coverImage && (
        <span className="absolute -right-8 top-[12%] h-28 w-28 rounded-full bg-white/8 blur-2xl" />
      )}

      <div className={`relative flex h-full flex-col ${large ? 'p-4 sm:p-5' : 'p-1.5'}`}>
        <div className="flex items-start justify-between gap-2">
          <span
            className={`flex items-center justify-center border border-white/30 bg-black/12 text-white shadow-inner backdrop-blur-[2px] ${large ? 'h-10 w-10 rounded-full' : 'h-7 w-7 rounded-full'}`}
          >
            <Emblem className={large ? 'h-5 w-5' : 'h-3.5 w-3.5'} strokeWidth={1.7} />
          </span>
          {diary.isLocked && (
            <span className="flex items-center gap-1 rounded-full border border-white/25 bg-black/25 p-1.5 text-white backdrop-blur-sm">
              <Lock className={large ? 'h-3.5 w-3.5' : 'h-3 w-3'} />
            </span>
          )}
        </div>

        {large && foilCount > 0 && (
          <div className="mt-auto mb-4 flex items-center gap-2 text-[#f5d99b] drop-shadow-md">
            {Array.from({ length: foilCount }, (_, index) => {
              const Mark = FOIL_MARKS[index % FOIL_MARKS.length];
              return (
                <Mark
                  key={`${diary.foilIcons?.[index]}-${index}`}
                  className="h-3.5 w-3.5"
                  strokeWidth={1.5}
                />
              );
            })}
          </div>
        )}

        {showTitle && large && (
          <div
            className={`${foilCount ? '' : 'mt-auto'} border-t border-white/25 pt-3 text-shadow-sm`}
          >
            <p className="line-clamp-2 font-serif-diary text-[clamp(1rem,2.4vw,1.35rem)] font-semibold leading-tight tracking-[-0.01em] text-white drop-shadow-md">
              {diary.name || 'Untitled journal'}
            </p>
            <span className="mt-2 block h-px w-8 bg-[#f5d99b]/80" />
          </div>
        )}
      </div>

      {large && (
        <span className="absolute inset-y-[7%] right-[-2px] w-[3px] rounded-full bg-[#f6eee4]/75 shadow-[-1px_0_2px_rgba(0,0,0,0.18)]" />
      )}
    </motion.div>
  );
}
