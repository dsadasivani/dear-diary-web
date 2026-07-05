import type { GoogleAccountSession, UserProfile } from '../types';
import { createDefaultUserProfile } from '../repositories/defaults';
import { cacheRemoteProfileImage } from '../mobile/mediaStorage';

type AvatarCache = (imageUrl: string) => Promise<string | null>;

const isUntouchedName = (profile: UserProfile): boolean => {
  const name = profile.name.trim();
  const genericDefault = createDefaultUserProfile().name;
  const emailDefault = createDefaultUserProfile(profile.email).name;
  return !name || name === genericDefault || name === emailDefault;
};

export const hasUntouchedAvatar = (profile: UserProfile): boolean => {
  const defaults = createDefaultUserProfile();
  return !profile.avatarUri
    && profile.avatarEmoji === defaults.avatarEmoji
    && profile.avatarColor === defaults.avatarColor;
};

export const mergeGoogleProfile = (
  profile: UserProfile,
  session: GoogleAccountSession,
  cachedAvatarUri?: string | null,
): UserProfile => {
  const updated: UserProfile = {
    ...profile,
    name: isUntouchedName(profile) && session.displayName?.trim()
      ? session.displayName.trim()
      : profile.name,
    email: !profile.email.trim() && session.email?.trim()
      ? session.email.trim()
      : profile.email,
  };
  if (hasUntouchedAvatar(profile) && cachedAvatarUri) {
    updated.avatarUri = cachedAvatarUri;
  }
  return updated;
};

export const populateUserProfileFromGoogle = async (
  profile: UserProfile,
  session: GoogleAccountSession,
  cacheAvatar: AvatarCache = cacheRemoteProfileImage,
): Promise<UserProfile> => {
  let cachedAvatarUri: string | null = null;
  if (hasUntouchedAvatar(profile) && session.imageUrl) {
    try {
      cachedAvatarUri = await cacheAvatar(session.imageUrl);
    } catch (error) {
      console.warn('Google profile image could not be cached; keeping the local avatar:', error);
    }
  }
  return mergeGoogleProfile(profile, session, cachedAvatarUri);
};
