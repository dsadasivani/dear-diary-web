import { useId, type KeyboardEvent, type ReactNode } from 'react';
import { Check } from 'lucide-react';

interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
  className?: string;
  testId?: string;
}

export function Switch({
  checked,
  onCheckedChange,
  label,
  description,
  disabled = false,
  className = '',
  testId,
}: SwitchProps) {
  const descriptionId = useId();
  return (
    <label
      className={`flex min-h-12 cursor-pointer items-center gap-3 ${disabled ? 'cursor-not-allowed opacity-50' : ''} ${className}`}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-bold text-ink">{label}</span>
        {description && (
          <span
            id={descriptionId}
            className="mt-1 block text-xs leading-relaxed text-ink-secondary"
          >
            {description}
          </span>
        )}
      </span>
      <input
        className="peer sr-only"
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        aria-describedby={description ? descriptionId : undefined}
        data-testid={testId}
        onChange={(event) => onCheckedChange(event.target.checked)}
      />
      <span
        aria-hidden="true"
        className="relative h-7 w-12 shrink-0 rounded-full border border-[var(--border-strong)] bg-surface-raised transition-colors peer-checked:border-accent peer-checked:bg-accent peer-focus-visible:shadow-[0_0_0_3px_color-mix(in_srgb,var(--focus-ring)_24%,transparent)] peer-disabled:opacity-60 after:absolute after:left-1 after:top-1 after:h-[18px] after:w-[18px] after:rounded-full after:bg-white after:shadow-sm after:transition-transform peer-checked:after:translate-x-5"
      />
    </label>
  );
}

interface CheckboxProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: ReactNode;
  description?: string;
  disabled?: boolean;
  className?: string;
}

export function Checkbox({
  checked,
  onCheckedChange,
  label,
  description,
  disabled = false,
  className = '',
}: CheckboxProps) {
  const descriptionId = useId();
  return (
    <label
      className={`flex min-h-11 cursor-pointer items-start gap-3 ${disabled ? 'cursor-not-allowed opacity-50' : ''} ${className}`}
    >
      <input
        className="peer sr-only"
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-describedby={description ? descriptionId : undefined}
        onChange={(event) => onCheckedChange(event.target.checked)}
      />
      <span
        aria-hidden="true"
        className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--radius-control-sm)] border border-[var(--border-strong)] bg-surface text-white peer-checked:border-accent peer-checked:bg-accent peer-focus-visible:shadow-[0_0_0_3px_color-mix(in_srgb,var(--focus-ring)_24%,transparent)]"
      >
        {checked && <Check className="h-3.5 w-3.5" />}
      </span>
      <span className="min-w-0 text-sm text-ink">
        <span className="font-semibold">{label}</span>
        {description && (
          <span
            id={descriptionId}
            className="mt-1 block text-xs leading-relaxed text-ink-secondary"
          >
            {description}
          </span>
        )}
      </span>
    </label>
  );
}

export interface SegmentedOption<Value extends string> {
  value: Value;
  label: string;
  icon?: ReactNode;
}

interface SegmentedControlProps<Value extends string> {
  value: Value;
  onChange: (value: Value) => void;
  options: Array<SegmentedOption<Value>>;
  label: string;
  className?: string;
}

export function SegmentedControl<Value extends string>({
  value,
  onChange,
  options,
  label,
  className = '',
}: SegmentedControlProps<Value>) {
  const moveSelection = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key))
      return;
    event.preventDefault();
    const backwards = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? options.length - 1
          : (index + (backwards ? -1 : 1) + options.length) % options.length;
    const next = options[nextIndex];
    onChange(next.value);
    event.currentTarget.parentElement
      ?.querySelectorAll<HTMLButtonElement>('[role="radio"]')
      [nextIndex]?.focus();
  };
  return (
    <fieldset className={className}>
      <legend className="sr-only">{label}</legend>
      <div
        className="inline-flex min-h-11 max-w-full items-center gap-1 overflow-x-auto rounded-[var(--radius-control)] border border-[var(--border-subtle)] bg-surface-subtle p-1"
        role="radiogroup"
        aria-label={label}
      >
        {options.map((option, index) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={option.value === value}
            tabIndex={option.value === value ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => moveSelection(event, index)}
            className={`inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-[calc(var(--radius-control)-0.25rem)] px-3 text-sm font-bold transition-colors ${option.value === value ? 'bg-surface-raised text-ink shadow-[var(--elevation-subtle)]' : 'text-ink-secondary hover:text-ink'}`}
          >
            {option.icon}
            {option.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
