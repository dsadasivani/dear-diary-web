import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import AccentThemeSelector from './AccentThemeSelector';

describe('AccentThemeSelector', () => {
  it('shows all named palettes and exposes the current selection', () => {
    render(<AccentThemeSelector value="quiet-grove" onChange={() => undefined} />);

    expect(screen.getByRole('radiogroup', { name: 'Color personality' })).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(5);
    expect(screen.getByRole('radio', { name: /Quiet Grove/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('radio', { name: /Twilight Ink/ })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('requests an immediate palette change when an option is selected', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<AccentThemeSelector value="quiet-grove" onChange={onChange} />);

    await user.click(screen.getByRole('radio', { name: /Warm Keepsake/ }));

    expect(onChange).toHaveBeenCalledWith('warm-keepsake');
  });
});
