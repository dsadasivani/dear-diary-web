import React, { useEffect, useRef, useState } from 'react';
import { eventSyncEngine } from '../repositories';
import { parseSyncMediaReference } from '../sync/syncMedia';

interface SyncedImageProps extends Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'src' | 'onClick'> {
  src: string;
  fallbackSrc?: string;
  label?: string;
  onClick?: (src: string) => void;
}

const resolvedCache = new Map<string, string>();
const inFlight = new Map<string, Promise<string>>();
const MAX_CACHE_SIZE = 100;
const TRANSPARENT_PLACEHOLDER_SRC = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

const classifyHydrationError = (error: unknown): string => {
  const message = String((error as { message?: unknown })?.message || '').toLowerCase();
  if (typeof navigator !== 'undefined' && !navigator.onLine) return 'Offline. Tap to retry.';
  if (message.includes('authorization') || message.includes('sign in') || message.includes('session')) {
    return 'Authorization required. Tap to retry.';
  }
  if (message.includes('missing') || message.includes('not found')) return 'Object missing. Tap to retry.';
  if (message.includes('integrity') || message.includes('verification') || message.includes('authentication')) {
    return 'Integrity check failed. Tap to retry.';
  }
  return 'Image unavailable. Tap to retry.';
};

const rememberResolved = (reference: string, resolved: string): void => {
  if (resolvedCache.has(reference)) resolvedCache.delete(reference);
  resolvedCache.set(reference, resolved);
  while (resolvedCache.size > MAX_CACHE_SIZE) {
    const oldest = resolvedCache.keys().next().value;
    if (!oldest) break;
    resolvedCache.delete(oldest);
  }
};

const hydrateReference = (reference: string, label: string): Promise<string> => {
  const cached = resolvedCache.get(reference);
  if (cached) return Promise.resolve(cached);
  const existing = inFlight.get(reference);
  if (existing) return existing;
  const pending = eventSyncEngine.hydrateMediaReference(reference, label)
    .then(resolved => {
      rememberResolved(reference, resolved);
      inFlight.delete(reference);
      return resolved;
    })
    .catch(error => {
      inFlight.delete(reference);
      throw error;
    });
  inFlight.set(reference, pending);
  return pending;
};

export default function SyncedImage({
  src,
  fallbackSrc,
  label = 'image',
  onClick,
  onError,
  className,
  ...imgProps
}: SyncedImageProps) {
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [resolvedSrc, setResolvedSrc] = useState<string | null>(() => (
    parseSyncMediaReference(src) ? resolvedCache.get(src) || null : src
  ));
  const [hydrationError, setHydrationError] = useState('');
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const [isVisible, setIsVisible] = useState(() => !parseSyncMediaReference(src) || resolvedCache.has(src));
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    if (!parseSyncMediaReference(src)) {
      setIsVisible(true);
      return undefined;
    }
    if (resolvedCache.has(src)) {
      setIsVisible(true);
      return undefined;
    }
    setIsVisible(false);
    if (typeof IntersectionObserver === 'undefined') {
      setIsVisible(true);
      return undefined;
    }
    const node = imageRef.current;
    if (!node) return undefined;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setIsVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: '240px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [src]);

  useEffect(() => {
    let cancelled = false;
    const isSyncReference = Boolean(parseSyncMediaReference(src));
    setResolvedSrc(isSyncReference ? resolvedCache.get(src) || null : src);
    setHydrationError('');
    if (!isSyncReference) return;
    if (!isVisible) return;

    void hydrateReference(src, label)
      .then(resolved => {
        if (!cancelled) setResolvedSrc(resolved);
      })
      .catch(error => {
        console.warn(`Synced ${label} could not be shown yet:`, error);
        if (!cancelled) {
          setHydrationError(classifyHydrationError(error));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isVisible, label, retryNonce, src]);

  const displaySrc = hydrationError ? (fallbackSrc || TRANSPARENT_PLACEHOLDER_SRC) : resolvedSrc || TRANSPARENT_PLACEHOLDER_SRC;
  const isPlaceholder = displaySrc === TRANSPARENT_PLACEHOLDER_SRC;
  const hydrationFailed = Boolean(hydrationError);
  const isSkeleton = isPlaceholder || loadedSrc !== displaySrc;

  useEffect(() => {
    if (isPlaceholder) {
      setLoadedSrc(null);
      return;
    }

    const node = imageRef.current;
    setLoadedSrc(node?.complete && node.naturalWidth > 0 ? displaySrc : null);
  }, [displaySrc, isPlaceholder]);

  const displayClassName = [
    className,
    isSkeleton ? 'synced-image-skeleton ring-1 ring-inset ring-brand-border/45 dark:ring-white/10' : '',
    isSkeleton && !hydrationFailed ? 'animate-pulse' : '',
  ].filter(Boolean).join(' ');
  const clickableSrc = resolvedSrc && !hydrationFailed ? resolvedSrc : null;

  return (
    <span className="relative inline-block h-full w-full">
      <img
        {...imgProps}
        ref={imageRef}
        src={displaySrc}
        className={displayClassName || undefined}
        aria-busy={(isSkeleton && !hydrationFailed) || undefined}
        data-image-state={hydrationFailed ? 'failed' : isSkeleton ? 'loading' : 'ready'}
        onClick={onClick && clickableSrc ? () => onClick(clickableSrc) : undefined}
        onLoad={(event) => {
          if (displaySrc !== TRANSPARENT_PLACEHOLDER_SRC) {
            setLoadedSrc(displaySrc);
          }
          imgProps.onLoad?.(event);
        }}
        onError={(event) => {
          if (displaySrc !== TRANSPARENT_PLACEHOLDER_SRC) {
            setHydrationError('Image unavailable. Tap to retry.');
          }
          onError?.(event);
        }}
      />
      {hydrationFailed && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            setResolvedSrc(null);
            setLoadedSrc(null);
            setHydrationError('');
            setRetryNonce(value => value + 1);
          }}
          className="absolute inset-0 flex items-center justify-center bg-brand-plum/55 px-2 text-center text-xs font-extrabold uppercase tracking-wide text-white"
        >
          {hydrationError}
        </button>
      )}
    </span>
  );
}
