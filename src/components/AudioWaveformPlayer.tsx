import { useRef, useState, useEffect, type ChangeEvent } from 'react';
import { Play, Pause, Volume2, Trash2 } from 'lucide-react';
import { eventSyncEngine } from '../repositories';
import { parseSyncMediaReference } from '../sync/syncMedia';

interface AudioWaveformPlayerProps {
  src: string; // Base64 raw audio data uri
  title?: string;
  onDelete?: () => void; // Optional delete action (useful in editor)
  variant?: 'default' | 'minimal';
}

const resolvedAudioCache = new Map<string, string>();
const inFlightAudio = new Map<string, Promise<string>>();
const MAX_AUDIO_CACHE_SIZE = 50;

const rememberResolvedAudio = (reference: string, resolved: string): void => {
  if (resolvedAudioCache.has(reference)) resolvedAudioCache.delete(reference);
  resolvedAudioCache.set(reference, resolved);
  while (resolvedAudioCache.size > MAX_AUDIO_CACHE_SIZE) {
    const oldest = resolvedAudioCache.keys().next().value;
    if (!oldest) break;
    resolvedAudioCache.delete(oldest);
  }
};

const hydrateAudioReference = (reference: string, label: string): Promise<string> => {
  const cached = resolvedAudioCache.get(reference);
  if (cached) return Promise.resolve(cached);
  const existing = inFlightAudio.get(reference);
  if (existing) return existing;
  const pending = eventSyncEngine.hydrateMediaReference(reference, label)
    .then(resolved => {
      rememberResolvedAudio(reference, resolved);
      inFlightAudio.delete(reference);
      return resolved;
    })
    .catch(error => {
      inFlightAudio.delete(reference);
      throw error;
    });
  inFlightAudio.set(reference, pending);
  return pending;
};

export default function AudioWaveformPlayer({ 
  src, 
  title = "Voice Note Sanctuary", 
  onDelete,
  variant = 'default'
}: AudioWaveformPlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [resolvedSrc, setResolvedSrc] = useState<string>(src);
  const [resolveError, setResolveError] = useState('');
  const [isHydratingAudio, setIsHydratingAudio] = useState(false);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(0);
  const needsAudioHydration = Boolean(parseSyncMediaReference(src)) && resolvedSrc === src;
  const isResolvingAudio = isHydratingAudio;
  const playableSrc = parseSyncMediaReference(resolvedSrc) ? undefined : resolvedSrc;

  // Generate deterministic bar heights for the visual waveform
  const numBars = 35;
  const barHeights = [
    30, 45, 60, 40, 55, 75, 90, 65, 50, 40, 35, 60, 80, 95, 70, 50,
    30, 45, 55, 75, 85, 60, 45, 30, 40, 65, 80, 55, 45, 35, 50, 60,
    45, 30, 20
  ];

  useEffect(() => {
    setResolvedSrc(parseSyncMediaReference(src) ? resolvedAudioCache.get(src) || src : src);
    setResolveError('');
    setIsHydratingAudio(false);
  }, [src, title]);

  const ensurePlayableSource = async (): Promise<string | null> => {
    if (!parseSyncMediaReference(src)) return resolvedSrc;
    if (!needsAudioHydration) return resolvedSrc;
    setIsHydratingAudio(true);
    setResolveError('');
    try {
      const resolved = await hydrateAudioReference(src, title);
      setResolvedSrc(resolved);
      return resolved;
    } catch (error: any) {
      console.warn('Synced audio could not be prepared yet:', error);
      setResolveError(error?.message || 'Audio could not be prepared.');
      return null;
    } finally {
      setIsHydratingAudio(false);
    }
  };

  useEffect(() => {
    // Reset play state if source changes
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    
    if (audioRef.current) {
      audioRef.current.load();
      
      const audio = audioRef.current;
      
      // Force duration discovery by seeking to the end and back
      // This is crucial for webm/blob recordings that lack duration headers
      const forceDurationDiscovery = () => {
        if (!isFinite(audio.duration) || audio.duration === 0) {
          audio.currentTime = 1e101; // Seek to "infinity"
          setTimeout(() => {
            if (audio) {
              audio.currentTime = 0;
            }
          }, 50);
        }
      };

      const updateDuration = () => {
        if (isFinite(audio.duration) && audio.duration > 0) {
          setDuration(audio.duration);
        }
      };

      const handleLoadedMetadata = () => {
        updateDuration();
        forceDurationDiscovery();
      };

      audio.addEventListener('loadedmetadata', handleLoadedMetadata);
      audio.addEventListener('durationchange', updateDuration);
      audio.addEventListener('canplaythrough', updateDuration);
      
      // Polling for duration as Blobs sometimes don't report it immediately
      const interval = setInterval(() => {
        if (isFinite(audio.duration) && audio.duration > 0) {
          setDuration(audio.duration);
          clearInterval(interval);
        } else if (audio.readyState >= 1) {
          forceDurationDiscovery();
        }
      }, 300);

      return () => {
        audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
        audio.removeEventListener('durationchange', updateDuration);
        audio.removeEventListener('canplaythrough', updateDuration);
        clearInterval(interval);
      };
    }
  }, [resolvedSrc]);

  const togglePlay = async () => {
    if (!audioRef.current || isResolvingAudio || resolveError) return;
    if (isPlaying) {
      audioRef.current.pause();
    } else {
      const resolved = await ensurePlayableSource();
      if (!resolved || !audioRef.current) return;
      if (audioRef.current.src !== resolved) {
        audioRef.current.src = resolved;
        audioRef.current.load();
      }
      // If duration is still not loaded, try to force it by seeking
      if (!isFinite(audioRef.current.duration) || audioRef.current.duration === 0) {
        audioRef.current.currentTime = 1e101;
        setTimeout(() => {
          if (audioRef.current) {
            audioRef.current.currentTime = 0;
            audioRef.current.play().catch(console.error);
          }
        }, 50);
      } else {
        audioRef.current.play().catch(err => {
          console.error("Audio playback error:", err);
        });
      }
    }
  };

  const handleTimeUpdate = () => {
    if (audioRef.current) {
      setCurrentTime(audioRef.current.currentTime);
      // Continuous duration update if not yet set
      if ((!duration || !isFinite(duration)) && isFinite(audioRef.current.duration) && audioRef.current.duration > 0) {
        setDuration(audioRef.current.duration);
      }
    }
  };

  const handleAudioEnded = () => {
    setIsPlaying(false);
    setCurrentTime(0);
  };

  const handleSeek = (e: ChangeEvent<HTMLInputElement>) => {
    if (!audioRef.current || !duration) return;
    const newTime = Number(e.currentTarget.value);
    audioRef.current.currentTime = newTime;
    setCurrentTime(newTime);
  };

  const formatTime = (time: number) => {
    if (!isFinite(time) || isNaN(time)) return '0:00';
    const mins = Math.floor(time / 60);
    const secs = Math.floor(time % 60);
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  };

  const progressPercentage = (duration > 0 && isFinite(duration)) ? (currentTime / duration) : 0;
  const activeBarIndex = Math.floor(progressPercentage * numBars);

  if (variant === 'minimal') {
    return (
      <div className="flex w-full max-w-sm animate-fade-in select-none items-center gap-3 border-y border-brand-border/50 py-2.5">
        <audio
          ref={audioRef}
          src={playableSrc}
          preload="metadata"
          onTimeUpdate={handleTimeUpdate}
          onEnded={handleAudioEnded}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          className="hidden"
        />

        <button
          type="button"
          onClick={togglePlay}
          disabled={isResolvingAudio || Boolean(resolveError)}
          aria-label={isPlaying ? `Pause ${title}` : `Play ${title}`}
          className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-brand-plum text-white transition-transform active:scale-95 disabled:opacity-45 dark:bg-brand-text dark:text-brand-bg"
        >
          {isPlaying ? (
            <Pause className="w-3 h-3 fill-white" />
          ) : (
            <Play className="w-3 h-3 fill-white translate-x-0.5" />
          )}
        </button>

        <div className="flex min-w-0 flex-grow flex-col">
          <span className="truncate text-xs font-bold tracking-tight text-brand-plum">{title}</span>
          <span className="font-mono text-[0.6875rem] font-semibold text-brand-text-muted">
            {formatTime(currentTime)} / {formatTime(duration || 0)}
          </span>
          {(isResolvingAudio || resolveError) && (
            <span className={`mt-0.5 text-[0.6875rem] ${resolveError ? 'text-brand-rose' : 'text-brand-text-muted'}`}>
              {resolveError || 'Preparing audio…'}
            </span>
          )}
        </div>

        {onDelete && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            aria-label={`Remove ${title}`}
            className="flex-shrink-0 rounded-full p-2 text-brand-rose transition-colors hover:bg-brand-rose/10"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="surface-paper relative flex w-full max-w-md animate-fade-in select-none flex-col gap-4 overflow-hidden rounded-[var(--radius-card)] border border-brand-border/60 px-4 py-3.5">
      <audio
        ref={audioRef}
        src={playableSrc}
        preload="metadata"
        onTimeUpdate={handleTimeUpdate}
        onEnded={handleAudioEnded}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        className="hidden"
      />

      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-brand-pink/10 text-brand-pink">
            <Volume2 className="h-3.5 w-3.5" />
          </span>
          <span className="truncate text-xs font-bold tracking-tight text-brand-plum">{title}</span>
        </div>

        {onDelete && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            aria-label={`Remove ${title}`}
            className="flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-bold text-brand-rose transition-colors hover:bg-brand-rose/10"
          >
            <Trash2 className="w-3 h-3" />
            Remove Recording
          </button>
        )}
      </div>

      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={togglePlay}
          disabled={isResolvingAudio || Boolean(resolveError)}
          aria-label={isPlaying ? `Pause ${title}` : `Play ${title}`}
          className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-brand-plum text-white shadow-sm transition-transform active:scale-95 disabled:opacity-45 dark:bg-brand-text dark:text-brand-bg"
        >
          {isPlaying ? (
            <Pause className="w-4.5 h-4.5 fill-white" />
          ) : (
            <Play className="w-4.5 h-4.5 fill-white translate-x-0.5" />
          )}
        </button>

        <div className="flex min-w-0 flex-grow flex-col gap-1.5">
          <div className="relative flex h-10 items-center gap-0.5">
            {barHeights.map((height, idx) => {
              const isActive = idx <= activeBarIndex;
              return (
                <div
                  key={idx}
                  className="flex-grow rounded-full transition-all duration-150"
                  style={{
                    height: `${height}%`,
                    backgroundColor: isActive ? 'var(--brand-pink)' : 'var(--brand-border)',
                  }}
                />
              );
            })}
            <input
              type="range"
              min={0}
              max={duration || 0}
              step="0.01"
              value={Math.min(currentTime, duration || 0)}
              onChange={handleSeek}
              disabled={!duration}
              aria-label={`Seek through ${title}`}
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-default"
            />
          </div>

          <div className="flex items-center justify-between font-mono text-[0.6875rem] font-semibold text-brand-text-muted">
            <span>{formatTime(currentTime)}</span>
            <span>{formatTime(duration || 0)}</span>
          </div>
        </div>
      </div>
      {(isResolvingAudio || resolveError) && (
        <p role={resolveError ? 'alert' : 'status'} className={`text-xs ${resolveError ? 'text-brand-rose' : 'text-brand-text-muted'}`}>
          {resolveError || 'Preparing this voice note…'}
        </p>
      )}
    </div>
  );
}
