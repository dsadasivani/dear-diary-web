import React, { useEffect, useState } from 'react';
import { eventSyncEngine } from '../repositories';
import { parseSyncMediaReference } from '../sync/syncMedia';

interface SyncedImageProps extends Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'src' | 'onClick'> {
  src: string;
  fallbackSrc?: string;
  label?: string;
  onClick?: (src: string) => void;
}

export default function SyncedImage({
  src,
  fallbackSrc,
  label = 'image',
  onClick,
  onError,
  ...imgProps
}: SyncedImageProps) {
  const [resolvedSrc, setResolvedSrc] = useState(src);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setResolvedSrc(src);
    setFailedSrc(null);
    if (!parseSyncMediaReference(src)) return;

    void eventSyncEngine.hydrateMediaReference(src, label)
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
  }, [fallbackSrc, label, src]);

  const displaySrc = failedSrc || resolvedSrc;

  return (
    <img
      {...imgProps}
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
