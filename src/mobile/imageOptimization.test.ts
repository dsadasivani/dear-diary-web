import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateTargetDimensions,
  canUseImageOptimizationWorker,
  getImageOptimizationPolicy,
  getImageOptimizationSkipReason,
  selectOutputMimeType,
  shouldUseOptimizedImage,
} from './imageOptimization';
import {
  cacheRemoteProfileImage,
  persistOptimizedImageDataUri,
  persistOptimizedImageFile,
} from './mediaStorage';

const optimizedImage = {
  dataUri: 'data:image/webp;base64,b3B0aW1pemVk',
  mimeType: 'image/webp',
  optimized: true,
  originalSize: 1_000_000,
  finalSize: 400_000,
};

test('image optimization policies use diary-sized defaults', () => {
  assert.deepEqual(getImageOptimizationPolicy('photo'), {
    maxLongEdge: 1920,
    quality: 0.84,
    smallFileThreshold: 150 * 1024,
  });
  assert.deepEqual(getImageOptimizationPolicy('cover'), {
    maxLongEdge: 1600,
    quality: 0.84,
    smallFileThreshold: 150 * 1024,
  });
  assert.deepEqual(getImageOptimizationPolicy('avatar'), {
    maxLongEdge: 512,
    quality: 0.84,
    smallFileThreshold: 50 * 1024,
  });
});

test('target dimensions preserve aspect ratio within max long edge', () => {
  assert.deepEqual(calculateTargetDimensions(4032, 3024, 1920), { width: 1920, height: 1440 });
  assert.deepEqual(calculateTargetDimensions(1200, 900, 1920), { width: 1200, height: 900 });
  assert.deepEqual(calculateTargetDimensions(1000, 3000, 1600), { width: 533, height: 1600 });
});

test('skip policy keeps unsupported and already-small images unchanged', () => {
  assert.equal(getImageOptimizationSkipReason('image/gif', 1_000_000, 'photo'), 'unsupported_mime');
  assert.equal(
    getImageOptimizationSkipReason('image/svg+xml', 1_000_000, 'cover'),
    'unsupported_mime',
  );
  assert.equal(
    getImageOptimizationSkipReason('application/octet-stream', 1_000_000, 'photo'),
    'unsupported_mime',
  );
  assert.equal(getImageOptimizationSkipReason('image/jpeg', 149 * 1024, 'photo'), 'small_file');
  assert.equal(getImageOptimizationSkipReason('image/jpeg', 49 * 1024, 'avatar'), 'small_file');
  assert.equal(getImageOptimizationSkipReason('image/jpeg', 150 * 1024, 'photo'), null);
});

test('candidate acceptance requires meaningful savings', () => {
  assert.equal(shouldUseOptimizedImage(1_000_000, 920_000), false);
  assert.equal(shouldUseOptimizedImage(1_000_000, 900_000), true);
  assert.equal(shouldUseOptimizedImage(5_000_000, 4_800_000), false);
  assert.equal(shouldUseOptimizedImage(5_000_000, 4_730_000), true);
  assert.equal(shouldUseOptimizedImage(500_000, 510_000), false);
});

test('output mime prefers WebP and falls back only for photo-like inputs', () => {
  assert.equal(selectOutputMimeType('image/jpeg', true), 'image/webp');
  assert.equal(selectOutputMimeType('image/png', true), 'image/webp');
  assert.equal(selectOutputMimeType('image/jpeg', false), 'image/jpeg');
  assert.equal(selectOutputMimeType('image/bmp', false), 'image/jpeg');
  assert.equal(selectOutputMimeType('image/png', false), null);
  assert.equal(selectOutputMimeType('image/webp', false), null);
});

test('worker optimization is gated by browser worker support', () => {
  assert.equal(canUseImageOptimizationWorker(), false);
});

test('optimized image files persist optimizer output', async () => {
  let receivedKind = '';
  let receivedBlob: Blob | null = null;
  const storedUri = await persistOptimizedImageFile(
    new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }),
    'photo',
    async (input, kind) => {
      receivedKind = kind;
      receivedBlob = input as Blob;
      return optimizedImage;
    },
  );

  assert.equal(receivedKind, 'photo');
  assert.equal(receivedBlob?.type, 'image/jpeg');
  assert.equal(storedUri, optimizedImage.dataUri);
});

test('optimized data URIs persist optimizer output', async () => {
  let receivedKind = '';
  let receivedDataUri = '';
  const storedUri = await persistOptimizedImageDataUri(
    'data:image/jpeg;base64,b3JpZ2luYWw=',
    'cover',
    'image/jpeg',
    async (input, kind) => {
      receivedKind = kind;
      receivedDataUri = typeof input === 'string' ? input : 'dataUri' in input ? input.dataUri : '';
      return optimizedImage;
    },
  );

  assert.equal(receivedKind, 'cover');
  assert.equal(receivedDataUri, 'data:image/jpeg;base64,b3JpZ2luYWw=');
  assert.equal(storedUri, optimizedImage.dataUri);
});

test('remote profile avatars optimize before persistence', async () => {
  const originalFetch = globalThis.fetch;
  (globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = async () =>
    new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'Content-Type': 'image/jpeg' },
    });

  try {
    let receivedKind = '';
    let receivedDataUri = '';
    const storedUri = await cacheRemoteProfileImage(
      'https://example.test/avatar.jpg',
      async (input, kind) => {
        receivedKind = kind;
        receivedDataUri =
          typeof input === 'string' ? input : 'dataUri' in input ? input.dataUri : '';
        return optimizedImage;
      },
    );

    assert.equal(receivedKind, 'avatar');
    assert.match(receivedDataUri, /^data:image\/jpeg;base64,/);
    assert.equal(storedUri, optimizedImage.dataUri);
  } finally {
    (globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = originalFetch;
  }
});
