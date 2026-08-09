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
    <span className="relative flex h-full w-full items-center justify-center">
      <span aria-hidden="true">{profile.avatarEmoji}</span>
      {profile.avatarUri && (
        <span className="absolute inset-0 block">
          <SyncedImage
            src={profile.avatarUri}
            alt={`${profile.name || 'User'} profile`}
            className={imageClassName}
            label="profile image"
          />
        </span>
      )}
    </span>
  );
}
