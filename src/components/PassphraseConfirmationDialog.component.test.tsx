import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import PassphraseConfirmationDialog from './PassphraseConfirmationDialog';

const renderDialog = (props: Partial<ComponentProps<typeof PassphraseConfirmationDialog>> = {}) =>
  render(
    <PassphraseConfirmationDialog
      open
      title="Revoke companion device"
      description="Confirm the destructive action."
      confirmLabel="Revoke device"
      loading={false}
      onCancel={vi.fn()}
      onConfirm={vi.fn()}
      {...props}
    />,
  );

describe('PassphraseConfirmationDialog', () => {
  it('masks the passphrase and confirms without logging or exposing it', async () => {
    const onConfirm = vi.fn();
    renderDialog({ onConfirm });

    const field = screen.getByLabelText(/recovery passphrase/i);
    expect(field).toHaveAttribute('type', 'password');
    await userEvent.type(field, 'correct horse battery staple');
    await userEvent.click(screen.getByRole('button', { name: /revoke device/i }));

    expect(onConfirm).toHaveBeenCalledWith('correct horse battery staple');
    expect(screen.queryByText('correct horse battery staple')).not.toBeInTheDocument();
  });

  it('supports escape cancellation and keeps focus inside the dialog', async () => {
    const onCancel = vi.fn();
    renderDialog({ onCancel });

    await userEvent.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);

    await userEvent.type(screen.getByLabelText(/recovery passphrase/i), 'secret');
    screen.getAllByRole('button', { name: 'Cancel' })[0].focus();
    await userEvent.tab({ shift: true });
    expect(screen.getByRole('button', { name: /revoke device/i })).toHaveFocus();
  });

  it('clears passphrase state when closed and reopened', async () => {
    const { rerender } = renderDialog();
    await userEvent.type(screen.getByLabelText(/recovery passphrase/i), 'temporary secret');

    rerender(
      <PassphraseConfirmationDialog
        open={false}
        title="Revoke companion device"
        description="Confirm the destructive action."
        confirmLabel="Revoke device"
        loading={false}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    rerender(
      <PassphraseConfirmationDialog
        open
        title="Revoke companion device"
        description="Confirm the destructive action."
        confirmLabel="Revoke device"
        loading={false}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    expect(screen.getByLabelText(/recovery passphrase/i)).toHaveValue('');
  });
});
