import React, { useRef, useState, useEffect } from 'react';
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

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!audioRef.current || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const percentage = clickX / rect.width;
    const newTime = percentage * duration;
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
      <div className="bg-brand-card-bg/80 px-3 py-2 rounded-2xl border border-brand-border/60 flex items-center gap-3 w-full max-w-sm select-none animate-fade-in relative">
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
          className="w-7 h-7 flex-shrink-0 bg-brand-pink hover:bg-brand-pink-dark text-white rounded-full flex items-center justify-center shadow-sm active:scale-95 transition-transform disabled:opacity-45"
        >
          {isPlaying ? (
            <Pause className="w-3 h-3 fill-white" />
          ) : (
            <Play className="w-3 h-3 fill-white translate-x-0.5" />
          )}
        </button>

        <div className="flex-grow flex flex-col min-w-0">
          <span className="text-[10px] font-bold text-brand-plum truncate tracking-tight">{title}</span>
          <span className="text-[9px] font-mono text-brand-sage font-semibold">
            {formatTime(currentTime)} / {formatTime(duration || 0)}
          </span>
        </div>

        {onDelete && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="flex-shrink-0 p-1.5 text-brand-rose hover:bg-brand-rose/10 rounded-full transition-all"
            title="Remove Recording"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="bg-brand-card-bg/95 p-4 rounded-3xl border border-brand-border/90 journal-shadow flex flex-col gap-3 max-w-md w-full select-none animate-fade-in relative overflow-hidden">
      {/* Decorative subtle background gradient */}
      <div className="absolute -right-10 -bottom-10 w-24 h-24 bg-brand-pink/5 rounded-full blur-xl pointer-events-none" />
      
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

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="p-1.5 bg-brand-pink/10 text-brand-pink rounded-lg flex items-center justify-center">
            <Volume2 className="w-3.5 h-3.5 animate-pulse" />
          </span>
          <span className="text-xs font-bold text-brand-plum tracking-tight">{title}</span>
        </div>

        {onDelete && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="flex items-center gap-1.5 text-[10px] font-bold text-brand-rose hover:text-brand-rose-dark bg-brand-rose/5 hover:bg-brand-rose/15 px-2.5 py-1 rounded-full transition-all border border-brand-rose/10"
          >
            <Trash2 className="w-3 h-3" />
            Remove Recording
          </button>
        )}
      </div>

      <div className="flex items-center gap-4 py-1">
        {/* Playback trigger button */}
        <button
          type="button"
          onClick={togglePlay}
          disabled={isResolvingAudio || Boolean(resolveError)}
          className="w-10 h-10 flex-shrink-0 bg-brand-pink hover:bg-brand-pink-dark text-white rounded-full flex items-center justify-center shadow-md active:scale-95 transition-transform disabled:opacity-45"
        >
          {isPlaying ? (
            <Pause className="w-4.5 h-4.5 fill-white" />
          ) : (
            <Play className="w-4.5 h-4.5 fill-white translate-x-0.5" />
          )}
        </button>

        {/* Waveform Visualization Grid Container */}
        <div className="flex-grow flex flex-col gap-1.5">
          <div 
            onClick={handleSeek}
            className="h-9 flex items-center gap-0.5 cursor-pointer select-none"
          >
            {barHeights.map((height, idx) => {
              const isActive = idx <= activeBarIndex;
              return (
                <div
                  key={idx}
                  className="flex-grow rounded-full transition-all duration-150"
                  style={{
                    height: `${height}%`,
                    backgroundColor: isActive ? 'var(--color-brand-pink, #df7d8d)' : 'rgba(223, 125, 141, 0.25)',
                    transform: isActive ? 'scaleY(1.05)' : 'scaleY(1)'
                  }}
                />
              );
            })}
          </div>

          {/* Timestamps */}
          <div className="flex justify-between items-center text-[10px] font-mono text-brand-sage font-semibold">
            <span>{formatTime(currentTime)}</span>
            <span>{formatTime(duration || 0)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
