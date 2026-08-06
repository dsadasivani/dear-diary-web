import { useEffect, useMemo, useRef, useState } from 'react';

interface AvatarCropperProps {
  file: File;
  busy?: boolean;
  onCancel: () => void;
  onChoose: (image: Blob) => void | Promise<void>;
}

interface ImageSize {
  width: number;
  height: number;
}

interface PanPoint {
  x: number;
  y: number;
}

const OUTPUT_SIZE = 512;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export const calculateAvatarCrop = (
  image: ImageSize,
  zoom: number,
  pan: PanPoint,
): { sourceX: number; sourceY: number; sourceSize: number } => {
  const sourceSize = Math.min(image.width, image.height) / clamp(zoom, 1, 3);
  const horizontalTravel = Math.max(0, image.width - sourceSize);
  const verticalTravel = Math.max(0, image.height - sourceSize);
  return {
    sourceX: (horizontalTravel / 2) * (1 + clamp(pan.x, -1, 1)),
    sourceY: (verticalTravel / 2) * (1 + clamp(pan.y, -1, 1)),
    sourceSize,
  };
};

const canvasBlob = (canvas: HTMLCanvasElement): Promise<Blob> =>
  new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Profile photo could not be prepared.'))),
      'image/png',
    );
  });

export default function AvatarCropper({
  file,
  busy = false,
  onCancel,
  onChoose,
}: AvatarCropperProps) {
  const imageRef = useRef<HTMLImageElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef<{ pointerX: number; pointerY: number; pan: PanPoint } | null>(null);
  const [imageSize, setImageSize] = useState<ImageSize>({ width: 1, height: 1 });
  const [viewportSize, setViewportSize] = useState(288);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<PanPoint>({ x: 0, y: 0 });
  const [preparing, setPreparing] = useState(false);
  const sourceUrl = useMemo(() => URL.createObjectURL(file), [file]);

  useEffect(() => () => URL.revokeObjectURL(sourceUrl), [sourceUrl]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const updateSize = () => setViewportSize(viewport.clientWidth || 288);
    updateSize();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(updateSize);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  const baseScale = Math.max(viewportSize / imageSize.width, viewportSize / imageSize.height);
  const displayedWidth = imageSize.width * baseScale * zoom;
  const displayedHeight = imageSize.height * baseScale * zoom;
  const translateX = -pan.x * Math.max(0, (displayedWidth - viewportSize) / 2);
  const translateY = -pan.y * Math.max(0, (displayedHeight - viewportSize) / 2);

  const renderSelection = async (mode: 'crop' | 'full') => {
    const image = imageRef.current;
    if (!image || !image.complete || image.naturalWidth < 1) return;
    setPreparing(true);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = OUTPUT_SIZE;
      canvas.height = OUTPUT_SIZE;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Profile photo editing is unavailable on this device.');
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';

      if (mode === 'full') {
        const scale = Math.min(OUTPUT_SIZE / imageSize.width, OUTPUT_SIZE / imageSize.height);
        const width = imageSize.width * scale;
        const height = imageSize.height * scale;
        context.drawImage(
          image,
          (OUTPUT_SIZE - width) / 2,
          (OUTPUT_SIZE - height) / 2,
          width,
          height,
        );
      } else {
        const crop = calculateAvatarCrop(imageSize, zoom, pan);
        context.drawImage(
          image,
          crop.sourceX,
          crop.sourceY,
          crop.sourceSize,
          crop.sourceSize,
          0,
          0,
          OUTPUT_SIZE,
          OUTPUT_SIZE,
        );
      }
      await onChoose(await canvasBlob(canvas));
    } finally {
      setPreparing(false);
    }
  };

  const unavailable = busy || preparing;

  return (
    <div className="avatar-cropper">
      <p className="mb-4 text-sm leading-relaxed text-ink-secondary">
        Drag to choose the part shown in your profile circle, then adjust the zoom if needed.
      </p>
      <div
        ref={viewportRef}
        className="relative mx-auto aspect-square w-full max-w-72 touch-none overflow-hidden rounded-3xl bg-surface-subtle shadow-inner"
        onPointerDown={(event) => {
          if (unavailable) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          dragStart.current = { pointerX: event.clientX, pointerY: event.clientY, pan };
        }}
        onPointerMove={(event) => {
          if (!dragStart.current || unavailable) return;
          const horizontalTravel = Math.max(1, (displayedWidth - viewportSize) / 2);
          const verticalTravel = Math.max(1, (displayedHeight - viewportSize) / 2);
          setPan({
            x: clamp(
              dragStart.current.pan.x -
                (event.clientX - dragStart.current.pointerX) / horizontalTravel,
              -1,
              1,
            ),
            y: clamp(
              dragStart.current.pan.y -
                (event.clientY - dragStart.current.pointerY) / verticalTravel,
              -1,
              1,
            ),
          });
        }}
        onPointerUp={() => {
          dragStart.current = null;
        }}
        onPointerCancel={() => {
          dragStart.current = null;
        }}
      >
        <img
          ref={imageRef}
          src={sourceUrl}
          alt="Profile crop preview"
          draggable={false}
          onLoad={(event) =>
            setImageSize({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            })
          }
          className="pointer-events-none absolute left-1/2 top-1/2 max-w-none select-none"
          style={{
            width: displayedWidth,
            height: displayedHeight,
            transform: `translate(-50%, -50%) translate(${translateX}px, ${translateY}px)`,
          }}
        />
        <div
          className="pointer-events-none absolute inset-0 rounded-full border-2 border-white/90 shadow-[0_0_0_999px_rgba(20,24,31,0.38)]"
          aria-hidden="true"
        />
      </div>
      <label className="mt-5 block text-xs font-bold uppercase tracking-wider text-brand-sage">
        Zoom
        <input
          type="range"
          min="1"
          max="3"
          step="0.05"
          value={zoom}
          disabled={unavailable}
          onChange={(event) => setZoom(Number(event.target.value))}
          className="mt-2 w-full accent-[var(--color-primary)]"
        />
      </label>
      <div className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <button
          type="button"
          disabled={unavailable}
          onClick={() => void renderSelection('full')}
          className="min-h-11 rounded-xl border border-brand-border px-4 text-sm font-bold text-brand-plum disabled:opacity-50 dark:text-brand-text"
        >
          Use full image
        </button>
        <button
          type="button"
          disabled={unavailable}
          onClick={() => void renderSelection('crop')}
          className="min-h-11 rounded-xl bg-brand-sage px-4 text-sm font-bold text-white disabled:opacity-50"
        >
          {unavailable ? 'Preparing photo…' : 'Use crop'}
        </button>
      </div>
      <button
        type="button"
        disabled={unavailable}
        onClick={onCancel}
        className="mt-2 min-h-11 w-full rounded-xl px-4 text-sm font-bold text-ink-secondary disabled:opacity-50"
      >
        Choose another image
      </button>
    </div>
  );
}
