import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateAvatarCrop } from './AvatarCropper';

test('centers a square avatar crop by default', () => {
  assert.deepEqual(calculateAvatarCrop({ width: 1200, height: 800 }, 1, { x: 0, y: 0 }), {
    sourceX: 200,
    sourceY: 0,
    sourceSize: 800,
  });
});

test('moves and zooms an avatar crop without leaving the source image', () => {
  assert.deepEqual(calculateAvatarCrop({ width: 1200, height: 800 }, 2, { x: 1, y: -1 }), {
    sourceX: 800,
    sourceY: 0,
    sourceSize: 400,
  });
});
