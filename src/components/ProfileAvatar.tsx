import type { UserProfile } from '../types';
import SyncedImage from './SyncedImage';

interface ProfileAvatarProps {
  profile: UserProfile;
  imageClassName?: string;
}

export default function ProfileAvatar({
  profile,
  imageClassName = 'absolute inset-0 w-full h-full object-cover',
}: ProfileAvatarProps) {
  return (
    <>
      <span aria-hidden="true">{profile.avatarEmoji}</span>
      {profile.avatarUri && (
        <SyncedImage
          src={profile.avatarUri}
          alt={`${profile.name || 'User'} profile`}
          className={imageClassName}
          label="profile image"
        />
      )}
    </>
  );
}
