import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AppButton, AppDialog } from './UiPrimitives';

describe('AppDialog', () => {
  it('traps keyboard focus, closes with Escape, and restores prior focus', async () => {
    const onClose = vi.fn();
    const view = render(<><button>Launcher</button><AppDialog open={false} title="Confirm action" onClose={onClose} footer={<AppButton>Confirm</AppButton>}><input aria-label="PIN" /></AppDialog></>);
    const launcher = screen.getByRole('button', { name: 'Launcher' });
    launcher.focus();
    view.rerender(<><button>Launcher</button><AppDialog open title="Confirm action" onClose={onClose} footer={<AppButton>Confirm</AppButton>}><input aria-label="PIN" /></AppDialog></>);
    const close = screen.getByRole('button', { name: 'Close dialog' });
    await waitFor(() => expect(close).toHaveFocus());
    await userEvent.tab({ shift: true });
    expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
    view.rerender(<><button>Launcher</button><AppDialog open={false} title="Confirm action" onClose={onClose} footer={<AppButton>Confirm</AppButton>}><input aria-label="PIN" /></AppDialog></>);
    expect(screen.getByRole('button', { name: 'Launcher' })).toHaveFocus();
  });
});
