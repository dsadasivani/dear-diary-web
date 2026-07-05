import { useEffect, useState } from 'react';
import type { UserProfile } from '../types';

interface ProfileAvatarProps {
  profile: UserProfile;
  imageClassName?: string;
}

export default function ProfileAvatar({
  profile,
  imageClassName = 'absolute inset-0 w-full h-full object-cover',
}: ProfileAvatarProps) {
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => setImageFailed(false), [profile.avatarUri]);

  return (
    <>
      <span aria-hidden="true">{profile.avatarEmoji}</span>
      {profile.avatarUri && !imageFailed && (
        <img
          src={profile.avatarUri}
          alt={`${profile.name || 'User'} profile`}
          className={imageClassName}
          onError={() => setImageFailed(true)}
        />
      )}
    </>
  );
}
