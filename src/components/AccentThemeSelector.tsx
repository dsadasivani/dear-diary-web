import { Check, Palette } from 'lucide-react';
import { ACCENT_THEME_OPTIONS, type AccentThemeId } from '../design/accentThemes';

interface AccentThemeSelectorProps {
  value: AccentThemeId;
  onChange: (value: AccentThemeId) => void;
}

export default function AccentThemeSelector({ value, onChange }: AccentThemeSelectorProps) {
  return (
    <div className="bg-brand-card-bg p-5 rounded-3xl journal-shadow border border-brand-border flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <span className="p-2.5 bg-accent-soft text-[var(--color-primary-on-container)] rounded-2xl">
          <Palette aria-hidden="true" className="w-4 h-4" />
        </span>
        <div>
          <h3 className="text-sm font-bold text-brand-plum">Color Personality</h3>
          <p className="text-xs text-brand-sage mt-0.5">
            Choose the atmosphere that feels most like your space
          </p>
        </div>
      </div>

      <div
        className="grid grid-cols-1 gap-2 sm:grid-cols-2"
        role="radiogroup"
        aria-label="Color personality"
      >
        {ACCENT_THEME_OPTIONS.map((option) => {
          const isSelected = value === option.id;
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={isSelected}
              onClick={() => onChange(option.id)}
              className={`group flex min-h-[4.5rem] items-center gap-3 rounded-[var(--radius-control)] border p-3 text-left transition-[background-color,border-color,box-shadow,transform] active:scale-[0.99] ${
                isSelected
                  ? 'border-accent bg-accent-soft shadow-sm'
                  : 'border-brand-border bg-brand-bg hover:border-accent hover:bg-accent-soft'
              }`}
            >
              <span
                aria-hidden="true"
                className="h-10 w-10 shrink-0 rounded-full border-2 border-white/80 shadow-sm ring-1 ring-black/10"
                style={{
                  background: `linear-gradient(135deg, ${option.light.primary} 0 50%, ${option.dark.primary} 50% 100%)`,
                }}
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-sm font-bold text-brand-plum">
                  {option.name}
                  {isSelected && (
                    <Check aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-accent" />
                  )}
                </span>
                <span className="mt-0.5 block text-xs leading-snug text-brand-text-muted">
                  {option.description}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      <p className="text-[11px] leading-relaxed text-brand-text-muted">
        This preference stays on this device, so your phone and web app can each feel like yours.
      </p>
    </div>
  );
}
