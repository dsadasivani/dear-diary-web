import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SyncCatchUpOverlay from './SyncCatchUpOverlay';

describe('SyncCatchUpOverlay', () => {
  afterEach(() => vi.useRealTimers());
  it('shows session-relative progress while stale content is blocked', () => {
    render(
      <SyncCatchUpOverlay
        gate={{
          phase: 'applying-events',
          startingSequence: 75,
          appliedSequence: 100,
          targetSequence: 100,
          appliedEvents: 25,
          totalEvents: 25,
          allowOffline: false,
        }}
        onRetry={vi.fn()}
        onContinueOffline={vi.fn()}
      />,
    );

    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText(/applying recent changes — 25 of 25/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/initial sync progress/i).firstElementChild).toHaveStyle({
      width: '100%',
    });
  });

  it('explains a slow secure retry and allows an existing device to continue offline', () => {
    vi.useFakeTimers();
    const onContinueOffline = vi.fn();
    render(
      <SyncCatchUpOverlay
        gate={{
          phase: 'applying-events',
          startingSequence: 12,
          appliedSequence: 12,
          targetSequence: 14,
          totalEvents: 2,
          allowOffline: true,
        }}
        onRetry={vi.fn()}
        onContinueOffline={onContinueOffline}
      />,
    );

    act(() => vi.advanceTimersByTime(8_000));
    expect(screen.getByText(/still reconnecting securely/i)).toBeInTheDocument();
    expect(screen.getByText(/retrying automatically/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /use offline copy while retrying/i }));
    expect(onContinueOffline).toHaveBeenCalledOnce();
  });

  it('allows retry but keeps a new empty companion blocked from offline use', () => {
    const onRetry = vi.fn();
    const view = render(
      <SyncCatchUpOverlay
        gate={{
          phase: 'failed',
          startingSequence: 0,
          appliedSequence: 0,
          targetSequence: 10,
          allowOffline: false,
          error: 'Network unavailable',
          recoverable: true,
        }}
        onRetry={onRetry}
        onContinueOffline={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /retry sync/i }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: /use offline copy/i })).not.toBeInTheDocument();

    view.rerender(
      <SyncCatchUpOverlay
        gate={{ phase: 'failed', startingSequence: 0, appliedSequence: 6, allowOffline: true }}
        onRetry={onRetry}
        onContinueOffline={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /use offline copy/i })).toBeInTheDocument();
  });
});
