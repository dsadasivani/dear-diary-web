import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ProfileAvatar from './ProfileAvatar';

describe('ProfileAvatar', () => {
  it('layers a profile photo over the fallback emblem', () => {
    const { container } = render(
      <div className="relative flex h-12 w-12">
        <ProfileAvatar
          profile={{
            name: 'Writer',
            email: '',
            bio: '',
            avatarEmoji: '🌸',
            avatarColor: '#97415f',
            avatarUri: 'data:image/png;base64,aGVsbG8=',
            writingGoal: 250,
            joinedDate: '07/2026',
          }}
        />
      </div>,
    );

    const avatarRoot = container.firstElementChild?.firstElementChild;
    const photo = screen.getByRole('img', { name: 'Writer profile' });
    const photoLayer = photo.parentElement?.parentElement;

    expect(avatarRoot).toHaveClass('relative', 'h-full', 'w-full');
    expect(photoLayer).toHaveClass('absolute', 'inset-0');
    expect(photoLayer?.parentElement).toBe(avatarRoot);
  });
});
