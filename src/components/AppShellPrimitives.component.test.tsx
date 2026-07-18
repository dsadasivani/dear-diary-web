import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  CreateActionSheet,
  MobileBottomNavigation,
  isRootDestinationScreen,
} from './AppShellPrimitives';

describe('redesigned application shell', () => {
  it('only classifies primary list screens as root destinations', () => {
    expect(isRootDestinationScreen('home', 'list')).toBe(true);
    expect(isRootDestinationScreen('diaries', 'diaryDetail')).toBe(false);
    expect(isRootDestinationScreen('diaries', 'diarySettings')).toBe(false);
    expect(isRootDestinationScreen('search', 'list')).toBe(false);
    expect(isRootDestinationScreen('stats', 'appSettings')).toBe(false);
  });

  it('exposes four primary mobile destinations plus Create', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    const onCreate = vi.fn();
    render(<MobileBottomNavigation active="home" onNavigate={onNavigate} onCreate={onCreate} />);

    const navigation = screen.getByRole('navigation', { name: 'Primary' });
    expect(navigation.querySelectorAll('button')).toHaveLength(5);
    expect(screen.getByRole('button', { name: 'Today' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('button', { name: 'Search' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Journals' }));
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(onNavigate).toHaveBeenCalledWith('diaries');
    expect(onCreate).toHaveBeenCalledOnce();
  });

  it('closes the create sheet with Escape and explains unavailable entry actions', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <CreateActionSheet
        open
        hasJournals={false}
        onClose={onClose}
        onNewEntry={vi.fn()}
        onNewNote={vi.fn()}
        onVoice={vi.fn()}
        onPhoto={vi.fn()}
        onNewJournal={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('dialog', { name: 'What would you like to capture?' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New Journal Entry/ })).toBeDisabled();
    expect(screen.getAllByText('Create a journal first').length).toBeGreaterThan(0);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });
});
