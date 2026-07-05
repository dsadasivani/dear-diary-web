import assert from 'node:assert/strict';
import test from 'node:test';
import type { GoogleAccountSession, UserProfile } from '../types';
import { createDefaultUserProfile } from '../repositories/defaults';
import { populateUserProfileFromGoogle } from './googleProfile';

const googleSession: GoogleAccountSession = {
  userId: 'google-user-1',
  email: 'writer@example.com',
  displayName: 'Google Writer',
  imageUrl: 'https://example.com/avatar.jpg',
  accessToken: 'token',
};

test('populates an untouched local profile from Google', async () => {
  const profile = createDefaultUserProfile();
  const updated = await populateUserProfileFromGoogle(profile, googleSession, async () => 'file:///avatar.jpg');

  assert.equal(updated.name, 'Google Writer');
  assert.equal(updated.email, 'writer@example.com');
  assert.equal(updated.avatarUri, 'file:///avatar.jpg');
});

test('preserves customized fields while filling untouched fields', async () => {
  const profile: UserProfile = {
    ...createDefaultUserProfile(),
    name: 'My Pen Name',
    avatarEmoji: '🦊',
  };
  let avatarCacheCalled = false;
  const updated = await populateUserProfileFromGoogle(profile, googleSession, async () => {
    avatarCacheCalled = true;
    return 'file:///avatar.jpg';
  });

  assert.equal(updated.name, 'My Pen Name');
  assert.equal(updated.email, 'writer@example.com');
  assert.equal(updated.avatarEmoji, '🦊');
  assert.equal(updated.avatarUri, undefined);
  assert.equal(avatarCacheCalled, false);
});

test('missing Google values never erase local profile fields', async () => {
  const profile = createDefaultUserProfile();
  const updated = await populateUserProfileFromGoogle(profile, {
    ...googleSession,
    email: null,
    displayName: null,
    imageUrl: null,
  });

  assert.deepEqual(updated, profile);
});

test('avatar download failure keeps the emoji but still imports name and email', async () => {
  const profile = createDefaultUserProfile();
  const originalWarn = console.warn;
  console.warn = () => undefined;
  let updated: UserProfile;
  try {
    updated = await populateUserProfileFromGoogle(profile, googleSession, async () => {
      throw new Error('offline');
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(updated.name, 'Google Writer');
  assert.equal(updated.email, 'writer@example.com');
  assert.equal(updated.avatarUri, undefined);
  assert.equal(updated.avatarEmoji, profile.avatarEmoji);
});
