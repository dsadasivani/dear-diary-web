import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SyncedImage from './SyncedImage';

const mocks = vi.hoisted(() => ({
  hydrateMediaReference: vi.fn(),
}));

vi.mock('../repositories', () => ({
  eventSyncEngine: {
    hydrateMediaReference: mocks.hydrateMediaReference,
  },
}));

const syncReference = 'ddmedia:v2:media-1:drive-1';
const failingSyncReference = 'ddmedia:v2:media-2:drive-2';
const fallbackSrc = 'https://example.test/fallback.jpg';
const hydratedSrc = 'data:image/webp;base64,aHlkcmF0ZWQ=';

describe('SyncedImage', () => {
  beforeEach(() => {
    mocks.hydrateMediaReference.mockReset();
  });

  it('shows a neutral placeholder while hydrating synced media', async () => {
    let resolveHydration: (value: string) => void = () => undefined;
    mocks.hydrateMediaReference.mockReturnValue(new Promise<string>(resolve => {
      resolveHydration = resolve;
    }));

    render(
      <SyncedImage
        src={syncReference}
        fallbackSrc={fallbackSrc}
        alt="entry photo"
        className="h-full w-full object-cover"
      />,
    );

    const image = screen.getByRole('img', { name: 'entry photo' });
    expect(image).toHaveAttribute('aria-busy', 'true');
    expect(image.getAttribute('src')).toMatch(/^data:image\/gif;base64,/);
    expect(image).not.toHaveAttribute('src', syncReference);
    expect(image).not.toHaveAttribute('src', fallbackSrc);

    resolveHydration(hydratedSrc);

    await waitFor(() => expect(image).toHaveAttribute('src', hydratedSrc));
    expect(image).toHaveAttribute('aria-busy', 'true');
    expect(image).toHaveAttribute('data-image-state', 'loading');

    fireEvent.load(image);

    expect(image).not.toHaveAttribute('aria-busy');
    expect(image).toHaveAttribute('data-image-state', 'ready');
  });

  it('keeps the skeleton visible until a regular image finishes loading', () => {
    render(
      <SyncedImage
        src="https://example.test/photo.jpg"
        alt="entry photo"
        className="h-full w-full object-cover"
      />,
    );

    const image = screen.getByRole('img', { name: 'entry photo' });
    expect(image).toHaveAttribute('src', 'https://example.test/photo.jpg');
    expect(image).toHaveAttribute('aria-busy', 'true');
    expect(image).toHaveAttribute('data-image-state', 'loading');

    fireEvent.load(image);

    expect(image).not.toHaveAttribute('aria-busy');
    expect(image).toHaveAttribute('data-image-state', 'ready');
    expect(mocks.hydrateMediaReference).not.toHaveBeenCalled();
  });

  it('returns to the skeleton state when the image source changes', () => {
    const { rerender } = render(
      <SyncedImage
        src="https://example.test/first.jpg"
        alt="entry photo"
        className="h-full w-full object-cover"
      />,
    );

    const image = screen.getByRole('img', { name: 'entry photo' });
    fireEvent.load(image);
    expect(image).toHaveAttribute('data-image-state', 'ready');

    rerender(
      <SyncedImage
        src="https://example.test/second.jpg"
        alt="entry photo"
        className="h-full w-full object-cover"
      />,
    );

    expect(image).toHaveAttribute('src', 'https://example.test/second.jpg');
    expect(image).toHaveAttribute('aria-busy', 'true');
    expect(image).toHaveAttribute('data-image-state', 'loading');
  });

  it('shows fallback media and a retry affordance after synced media hydration fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.hydrateMediaReference.mockRejectedValue(new Error('download failed'));

    try {
      render(
        <SyncedImage
          src={failingSyncReference}
          fallbackSrc={fallbackSrc}
          alt="entry photo"
          className="h-full w-full object-cover"
        />,
      );

      const image = screen.getByRole('img', { name: 'entry photo' });
      expect(image.getAttribute('src')).toMatch(/^data:image\/gif;base64,/);

      await waitFor(() => expect(image).toHaveAttribute('data-image-state', 'failed'));
      expect(image).toHaveAttribute('src', fallbackSrc);
      expect(image).not.toHaveAttribute('aria-busy');
      expect(screen.getByRole('button', { name: /image unavailable/i })).toBeInTheDocument();
    } finally {
      warn.mockRestore();
    }
  });
});
