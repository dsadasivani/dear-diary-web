import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import EntrySaveStatus from './EntrySaveStatus';

describe('EntrySaveStatus', () => {
  it('distinguishes local save from pending synchronization', async () => {
    const view = render(
      <EntrySaveStatus state="saved" lastSavedAt={new Date(2026, 0, 1, 9, 30)} />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(/Saved locally at/);
    view.rerender(<EntrySaveStatus state="offline-pending" />);
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(/sync waits for connection/),
    );
  });

  it('announces save failures as alerts', () => {
    render(<EntrySaveStatus state="error" message="Storage is unavailable" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Storage is unavailable');
  });
});
