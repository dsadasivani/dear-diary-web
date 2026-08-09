import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import SyncCatchUpOverlay from './SyncCatchUpOverlay';

describe('SyncCatchUpOverlay', () => {
  it('shows applied and target sequence progress while stale content is blocked', () => {
    render(
      <SyncCatchUpOverlay
        gate={{
          phase: 'pulling',
          appliedSequence: 25,
          targetSequence: 100,
          allowOffline: false,
        }}
        onRetry={vi.fn()}
        onContinueOffline={vi.fn()}
      />,
    );

    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText(/applied 25 of 100 encrypted updates/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/initial sync progress/i).firstElementChild).toHaveStyle({
      width: '25%',
    });
  });

  it('allows retry but keeps a new empty companion blocked from offline use', () => {
    const onRetry = vi.fn();
    const view = render(
      <SyncCatchUpOverlay
        gate={{
          phase: 'failed',
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
        gate={{ phase: 'failed', appliedSequence: 6, allowOffline: true }}
        onRetry={onRetry}
        onContinueOffline={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /use offline copy/i })).toBeInTheDocument();
  });
});
