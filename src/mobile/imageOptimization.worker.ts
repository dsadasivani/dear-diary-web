import {
  calculateTargetDimensions,
  getImageOptimizationPolicy,
  getImageOptimizationSkipReason,
  selectOutputMimeType,
  shouldUseOptimizedImage,
  type ImageOptimizationResult,
  type ImageStorageKind,
} from './imageOptimization';

interface WorkerImageSource {
  dataUri: string;
  mimeType: string;
  size: number;
}

interface WorkerRequest {
  id: string;
  kind: ImageStorageKind;
  source: WorkerImageSource;
}

type WorkerResponse =
  | { id: string; ok: true; result: ImageOptimizationResult }
  | { id: string; ok: false; error: string };

const workerScope = globalThis as typeof globalThis & {
  postMessage: (message: WorkerResponse) => void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
};

const normalizeMimeType = (mimeType?: string): string => (
  (mimeType || '').split(';')[0].trim().toLowerCase()
);

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
};

const base64ToBytes = (base64: string): Uint8Array => {
  const binary = atob(base64.replace(/\s/g, ''));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
};

const parseDataUri = (dataUri: string, fallbackMimeType: string): { bytes: Uint8Array; mimeType: string } => {
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
  return {
    bytes: isBase64
      ? base64ToBytes(data)
      : new TextEncoder().encode(decodeURIComponent(data)),
    mimeType,
  };
};

const blobToDataUri = async (blob: Blob, fallbackMimeType: string): Promise<string> => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return `data:${blob.type || fallbackMimeType};base64,${bytesToBase64(bytes)}`;
};

const skipResult = (
  source: WorkerImageSource,
  reason: string,
): ImageOptimizationResult => ({
  dataUri: source.dataUri,
  mimeType: source.mimeType,
  optimized: false,
  originalSize: source.size,
  finalSize: source.size,
  skippedReason: reason,
});

const detectWebpSupport = async (): Promise<boolean> => {
  if (typeof OffscreenCanvas === 'undefined') return false;
  const canvas = new OffscreenCanvas(1, 1);
  const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.8 });
  return normalizeMimeType(blob.type) === 'image/webp';
};

const optimizeInWorker = async (
  source: WorkerImageSource,
  kind: ImageStorageKind,
): Promise<ImageOptimizationResult> => {
  const earlySkipReason = getImageOptimizationSkipReason(source.mimeType, source.size, kind);
  if (earlySkipReason) return skipResult(source, earlySkipReason);
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap !== 'function') {
    throw new Error('worker_image_apis_unavailable');
  }

  const webpSupported = await detectWebpSupport();
  const outputMimeType = selectOutputMimeType(source.mimeType, webpSupported);
  if (!outputMimeType) return skipResult(source, 'output_mime_unavailable');

  const parsed = parseDataUri(source.dataUri, source.mimeType);
  const blob = new Blob([parsed.bytes], { type: parsed.mimeType });
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' } as ImageBitmapOptions);
  try {
    if (bitmap.width < 1 || bitmap.height < 1) return skipResult(source, 'invalid_dimensions');

    const policy = getImageOptimizationPolicy(kind);
    const target = calculateTargetDimensions(bitmap.width, bitmap.height, policy.maxLongEdge);
    const canvas = new OffscreenCanvas(target.width, target.height);
    const context = canvas.getContext('2d');
    if (!context) return skipResult(source, 'canvas_unavailable');

    context.drawImage(bitmap, 0, 0, target.width, target.height);
    const candidateBlob = await canvas.convertToBlob({ type: outputMimeType, quality: policy.quality });
    const candidateMimeType = normalizeMimeType(candidateBlob.type || outputMimeType);
    if (!shouldUseOptimizedImage(source.size, candidateBlob.size)) {
      return skipResult(source, 'insufficient_savings');
    }

    return {
      dataUri: await blobToDataUri(candidateBlob, candidateMimeType),
      mimeType: candidateMimeType,
      optimized: true,
      originalSize: source.size,
      finalSize: candidateBlob.size,
    };
  } finally {
    bitmap.close();
  }
};

workerScope.onmessage = event => {
  const request = event.data;
  optimizeInWorker(request.source, request.kind)
    .then(result => workerScope.postMessage({ id: request.id, ok: true, result }))
    .catch(error => workerScope.postMessage({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : 'worker_optimization_failed',
    }));
};
