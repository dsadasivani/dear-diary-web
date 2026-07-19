import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  AppButton,
  AppDialog,
  BottomSheet,
  MenuItem,
  OverflowMenu,
  SegmentedControl,
} from './UiPrimitives';

describe('AppDialog', () => {
  it('traps keyboard focus, closes with Escape, and restores prior focus', async () => {
    const onClose = vi.fn();
    const view = render(
      <>
        <button>Launcher</button>
        <AppDialog
          open={false}
          title="Confirm action"
          onClose={onClose}
          footer={<AppButton>Confirm</AppButton>}
        >
          <input aria-label="PIN" />
        </AppDialog>
      </>,
    );
    const launcher = screen.getByRole('button', { name: 'Launcher' });
    launcher.focus();
    view.rerender(
      <>
        <button>Launcher</button>
        <AppDialog
          open
          title="Confirm action"
          onClose={onClose}
          footer={<AppButton>Confirm</AppButton>}
        >
          <input aria-label="PIN" />
        </AppDialog>
      </>,
    );
    const close = screen.getByRole('button', { name: 'Close dialog' });
    await waitFor(() => expect(close).toHaveFocus());
    await userEvent.tab({ shift: true });
    expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
    view.rerender(
      <>
        <button>Launcher</button>
        <AppDialog
          open={false}
          title="Confirm action"
          onClose={onClose}
          footer={<AppButton>Confirm</AppButton>}
        >
          <input aria-label="PIN" />
        </AppDialog>
      </>,
    );
    expect(screen.getByRole('button', { name: 'Launcher' })).toHaveFocus();
  });
});

describe('shared interaction primitives', () => {
  it('gives simultaneous sheets unique accessible names and descriptions', () => {
    render(
      <>
        <BottomSheet open title="First sheet" description="First description" onClose={vi.fn()}>
          First
        </BottomSheet>
        <BottomSheet open title="Second sheet" description="Second description" onClose={vi.fn()}>
          Second
        </BottomSheet>
      </>,
    );
    expect(screen.getByRole('dialog', { name: 'First sheet' })).toHaveAccessibleDescription(
      'First description',
    );
    expect(screen.getByRole('dialog', { name: 'Second sheet' })).toHaveAccessibleDescription(
      'Second description',
    );
  });

  it('supports roving arrow focus in overflow menus and restores the trigger', async () => {
    const user = userEvent.setup();
    render(
      <OverflowMenu label="Memory actions">
        <MenuItem>Rename</MenuItem>
        <MenuItem>Archive</MenuItem>
      </OverflowMenu>,
    );
    const trigger = screen.getByRole('button', { name: 'Memory actions' });
    await user.click(trigger);
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Rename' })).toHaveFocus());
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Archive' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(trigger).toHaveFocus();
  });

  it('supports arrow-key selection in segmented controls', async () => {
    const onChange = vi.fn();
    const view = render(
      <SegmentedControl
        label="Layout"
        value="grid"
        onChange={onChange}
        options={[
          { value: 'grid', label: 'Grid' },
          { value: 'list', label: 'List' },
        ]}
      />,
    );
    screen.getByRole('radio', { name: 'Grid' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenCalledWith('list');
    view.rerender(
      <SegmentedControl
        label="Layout"
        value="list"
        onChange={onChange}
        options={[
          { value: 'grid', label: 'Grid' },
          { value: 'list', label: 'List' },
        ]}
      />,
    );
    expect(screen.getByRole('radio', { name: 'List' })).toHaveAttribute('tabindex', '0');
  });
});
