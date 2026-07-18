import type { ComponentPropsWithoutRef, ReactNode } from 'react';

type SurfaceVariant = 'flat' | 'subtle' | 'raised' | 'overlay';

interface SurfaceProps extends ComponentPropsWithoutRef<'div'> {
  children: ReactNode;
  variant?: SurfaceVariant;
  className?: string;
}

export function Surface({ children, variant = 'flat', className = '', ...props }: SurfaceProps) {
  const variantClass = {
    flat: 'bg-surface',
    subtle: 'bg-surface-subtle',
    raised: 'surface-elevated',
    overlay: 'surface-modal',
  }[variant];
  return (
    <div className={`${variantClass} ${className}`} {...props}>
      {children}
    </div>
  );
}

export function PaperSurface({
  children,
  className = '',
  ...props
}: Omit<SurfaceProps, 'variant'>) {
  return (
    <div className={`surface-paper ${className}`} {...props}>
      {children}
    </div>
  );
}

interface GlassSurfaceProps extends Omit<SurfaceProps, 'variant'> {
  strong?: boolean;
  className?: string;
}

export function GlassSurface({
  children,
  strong = false,
  className = '',
  ...props
}: GlassSurfaceProps) {
  return (
    <div className={`${strong ? 'surface-glass-strong' : 'surface-glass'} ${className}`} {...props}>
      {children}
    </div>
  );
}
