import { recordPerformanceMeasurement } from '../utils/performance';

export type ImageStorageKind = 'photo' | 'cover' | 'avatar';

export interface ImageOptimizationResult {
  dataUri: string;
  mimeType: string;
  optimized: boolean;
  originalSize: number;
  finalSize: number;
  skippedReason?: string;
}

export interface ImageOptimizationPolicy {
  maxLongEdge: number;
  quality: number;
  smallFileThreshold: number;
}

interface ImageSource {
  blob: Blob;
  dataUri: string;
  mimeType: string;
  size: number;
}

type ImageOptimizationInput = Blob | string | { dataUri: string; mimeType?: string };

const ONE_KB = 1024;
const MIN_RELATIVE_SAVINGS = 0.1;
const MIN_ABSOLUTE_SAVINGS = 256 * ONE_KB;

export const IMAGE_OPTIMIZATION_POLICIES: Record<ImageStorageKind, ImageOptimizationPolicy> = {
  photo: {
    maxLongEdge: 1920,
    quality: 0.84,
    smallFileThreshold: 150 * ONE_KB,
  },
  cover: {
    maxLongEdge: 1600,
    quality: 0.84,
    smallFileThreshold: 150 * ONE_KB,
  },
  avatar: {
    maxLongEdge: 512,
    quality: 0.84,
    smallFileThreshold: 50 * ONE_KB,
  },
};

const SUPPORTED_SOURCE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/bmp',
]);

const MIME_TYPES_WITHOUT_ALPHA = new Set([
  'image/jpeg',
  'image/jpg',
  'image/bmp',
]);

let webpSupportPromise: Promise<boolean> | null = null;

const now = (): number => (
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
);

const normalizeMimeType = (mimeType?: string): string => (
  (mimeType || '').split(';')[0].trim().toLowerCase()
);

export const getImageOptimizationPolicy = (kind: ImageStorageKind): ImageOptimizationPolicy => (
  IMAGE_OPTIMIZATION_POLICIES[kind]
);

export const isSupportedImageMimeType = (mimeType: string): boolean => (
  SUPPORTED_SOURCE_MIME_TYPES.has(normalizeMimeType(mimeType))
);

export const getImageOptimizationSkipReason = (
  mimeType: string,
  originalSize: number,
  kind: ImageStorageKind,
): string | null => {
  const normalized = normalizeMimeType(mimeType);
  if (!isSupportedImageMimeType(normalized)) return 'unsupported_mime';
  if (originalSize < getImageOptimizationPolicy(kind).smallFileThreshold) return 'small_file';
  return null;
};

export const shouldUseOptimizedImage = (originalSize: number, candidateSize: number): boolean => {
  const saved = originalSize - candidateSize;
  if (saved <= 0) return false;
  return saved >= originalSize * MIN_RELATIVE_SAVINGS || saved >= MIN_ABSOLUTE_SAVINGS;
};

export const calculateTargetDimensions = (
  width: number,
  height: number,
  maxLongEdge: number,
): { width: number; height: number } => {
  const longEdge = Math.max(width, height);
  if (longEdge <= maxLongEdge) {
    return {
      width: Math.max(1, Math.round(width)),
      height: Math.max(1, Math.round(height)),
    };
  }
  const scale = maxLongEdge / longEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
};

export const selectOutputMimeType = (
  sourceMimeType: string,
  webpSupported: boolean,
): string | null => {
  const normalized = normalizeMimeType(sourceMimeType);
  if (webpSupported) return 'image/webp';
  return MIME_TYPES_WITHOUT_ALPHA.has(normalized) ? 'image/jpeg' : null;
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return typeof btoa === 'function' ? btoa(binary) : Buffer.from(binary, 'binary').toString('base64');
};

const base64ToBytes = (base64: string): Uint8Array => {
  const normalized = base64.replace(/\s/g, '');
  const binary = typeof atob === 'function' ? atob(normalized) : Buffer.from(normalized, 'base64').toString('binary');
  return Uint8Array.from(binary, character => character.charCodeAt(0));
};

const blobToDataUri = async (blob: Blob, fallbackMimeType: string): Promise<string> => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return `data:${blob.type || fallbackMimeType};base64,${bytesToBase64(bytes)}`;
};

const parseDataUri = (dataUri: string, fallbackMimeType?: string): { bytes: Uint8Array; mimeType: string } => {
  const commaIndex = dataUri.indexOf(',');
  if (!dataUri.startsWith('data:') || commaIndex < 0) {
    throw new Error('Image data URI is invalid.');
  }

  const metadata = dataUri.slice('data:'.length, commaIndex);
  const data = dataUri.slice(commaIndex + 1);
  const metadataParts = metadata.split(';').filter(Boolean);
  const isBase64 = metadataParts.some(part => part.toLowerCase() === 'base64');
  const mimeType = normalizeMimeType(
    metadataParts.find(part => part.includes('/')) || fallbackMimeType || 'application/octet-stream',
  );
  const bytes = isBase64
    ? base64ToBytes(data)
    : new TextEncoder().encode(decodeURIComponent(data));
  return { bytes, mimeType };
};

const sourceFromInput = async (input: ImageOptimizationInput): Promise<ImageSource> => {
  if (typeof input === 'string') {
    const parsed = parseDataUri(input);
    const blob = new Blob([parsed.bytes], { type: parsed.mimeType });
    return {
      blob,
      dataUri: input,
      mimeType: parsed.mimeType,
      size: parsed.bytes.byteLength,
    };
  }

  if ('dataUri' in input) {
    const parsed = parseDataUri(input.dataUri, input.mimeType);
    const blob = new Blob([parsed.bytes], { type: parsed.mimeType });
    return {
      blob,
      dataUri: input.dataUri,
      mimeType: parsed.mimeType,
      size: parsed.bytes.byteLength,
    };
  }

  const mimeType = normalizeMimeType(input.type || 'application/octet-stream');
  return {
    blob: input,
    dataUri: await blobToDataUri(input, mimeType),
    mimeType,
    size: input.size,
  };
};

const hasCanvasEncodingApis = (): boolean => (
  typeof document !== 'undefined'
  && typeof Blob !== 'undefined'
  && typeof URL !== 'undefined'
);

const canvasToBlob = (
  canvas: HTMLCanvasElement,
  mimeType: string,
  quality?: number,
): Promise<Blob | null> => (
  new Promise(resolve => canvas.toBlob(resolve, mimeType, quality))
);

const detectWebpSupport = async (): Promise<boolean> => {
  if (webpSupportPromise) return webpSupportPromise;
  webpSupportPromise = (async () => {
    if (!hasCanvasEncodingApis()) return false;
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    if (typeof canvas.toBlob !== 'function') return false;
    const blob = await canvasToBlob(canvas, 'image/webp', 0.8);
    return normalizeMimeType(blob?.type) === 'image/webp';
  })();
  return webpSupportPromise;
};

const decodeImage = async (blob: Blob): Promise<{
  width: number;
  height: number;
  draw: (context: CanvasRenderingContext2D, width: number, height: number) => void;
  close?: () => void;
}> => {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' } as ImageBitmapOptions);
      return {
        width: bitmap.width,
        height: bitmap.height,
        draw: (context, width, height) => context.drawImage(bitmap, 0, 0, width, height),
        close: () => bitmap.close(),
      };
    } catch {
      // Fall through to HTMLImageElement for WebViews without createImageBitmap support.
    }
  }

  if (typeof Image === 'undefined' || typeof URL === 'undefined') {
    throw new Error('Image decoding APIs are unavailable.');
  }

  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('Image decoding failed.'));
      element.src = objectUrl;
    });
    return {
      width: image.naturalWidth || image.width,
      height: image.naturalHeight || image.height,
      draw: (context, width, height) => context.drawImage(image, 0, 0, width, height),
    };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
};

const skipResult = (
  source: ImageSource,
  reason: string,
): ImageOptimizationResult => ({
  dataUri: source.dataUri,
  mimeType: source.mimeType,
  optimized: false,
  originalSize: source.size,
  finalSize: source.size,
  skippedReason: reason,
});

const optimizeImageSource = async (
  source: ImageSource,
  kind: ImageStorageKind,
): Promise<ImageOptimizationResult> => {
  const earlySkipReason = getImageOptimizationSkipReason(source.mimeType, source.size, kind);
  if (earlySkipReason) return skipResult(source, earlySkipReason);
  if (!hasCanvasEncodingApis()) return skipResult(source, 'browser_apis_unavailable');

  const webpSupported = await detectWebpSupport();
  const outputMimeType = selectOutputMimeType(source.mimeType, webpSupported);
  if (!outputMimeType) return skipResult(source, 'output_mime_unavailable');

  const policy = getImageOptimizationPolicy(kind);
  let decoded: Awaited<ReturnType<typeof decodeImage>> | null = null;

  try {
    decoded = await decodeImage(source.blob);
    if (decoded.width < 1 || decoded.height < 1) return skipResult(source, 'invalid_dimensions');

    const target = calculateTargetDimensions(decoded.width, decoded.height, policy.maxLongEdge);
    const canvas = document.createElement('canvas');
    canvas.width = target.width;
    canvas.height = target.height;
    const context = canvas.getContext('2d');
    if (!context || typeof canvas.toBlob !== 'function') return skipResult(source, 'canvas_unavailable');

    decoded.draw(context, target.width, target.height);

    const candidateBlob = await canvasToBlob(canvas, outputMimeType, policy.quality);
    if (!candidateBlob) return skipResult(source, 'encode_failed');

    const candidateMimeType = normalizeMimeType(candidateBlob.type || outputMimeType);
    const candidateSize = candidateBlob.size;
    if (!shouldUseOptimizedImage(source.size, candidateSize)) {
      return skipResult(source, 'insufficient_savings');
    }

    return {
      dataUri: await blobToDataUri(candidateBlob, candidateMimeType),
      mimeType: candidateMimeType,
      optimized: true,
      originalSize: source.size,
      finalSize: candidateSize,
    };
  } catch {
    return skipResult(source, 'optimization_failed');
  } finally {
    decoded?.close?.();
  }
};

export const optimizeImageForStorage = async (
  input: ImageOptimizationInput,
  kind: ImageStorageKind,
): Promise<ImageOptimizationResult> => {
  const startedAt = now();
  let result: ImageOptimizationResult | null = null;
  let sourceMime = 'unknown';
  let originalSize = 0;

  try {
    const source = await sourceFromInput(input);
    sourceMime = source.mimeType;
    originalSize = source.size;
    result = await optimizeImageSource(source, kind);
    return result;
  } finally {
    recordPerformanceMeasurement('image.optimize.storage', now() - startedAt, {
      kind,
      result: result?.optimized ? 'optimized' : result?.skippedReason || 'failed',
      originalSize: result?.originalSize ?? originalSize,
      finalSize: result?.finalSize ?? originalSize,
      sourceMime,
      outputMime: result?.mimeType || 'unknown',
    }, startedAt);
  }
};
