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
  ...imgProps
}: SyncedImageProps) {
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [resolvedSrc, setResolvedSrc] = useState(src);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [isVisible, setIsVisible] = useState(() => !parseSyncMediaReference(src));

  useEffect(() => {
    if (!parseSyncMediaReference(src)) {
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
    setResolvedSrc(src);
    setFailedSrc(null);
    if (!parseSyncMediaReference(src)) return;
    if (!isVisible) return;

    void hydrateReference(src, label)
      .then(resolved => {
        if (!cancelled) setResolvedSrc(resolved);
      })
      .catch(error => {
        console.warn(`Synced ${label} could not be shown yet:`, error);
        if (!cancelled && fallbackSrc) setFailedSrc(fallbackSrc);
      });

    return () => {
      cancelled = true;
    };
  }, [fallbackSrc, isVisible, label, src]);

  const displaySrc = failedSrc || resolvedSrc;

  return (
    <img
      {...imgProps}
      ref={imageRef}
      src={displaySrc}
      onClick={onClick ? () => onClick(displaySrc) : undefined}
      onError={(event) => {
        if (fallbackSrc && displaySrc !== fallbackSrc) {
          setFailedSrc(fallbackSrc);
        }
        onError?.(event);
      }}
    />
  );
}
