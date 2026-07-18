import type { ComponentPropsWithoutRef, ReactNode } from 'react';

interface PageLayoutProps extends ComponentPropsWithoutRef<'div'> {
  children: ReactNode;
  reading?: boolean;
  navigationClearance?: boolean;
  className?: string;
}

export function PageLayout({ children, reading = false, navigationClearance = false, className = '', ...props }: PageLayoutProps) {
  return (
    <div
      className={`page-frame ${reading ? 'reading-column' : ''} ${navigationClearance ? 'root-navigation-clearance' : ''} ${className}`}
      {...props}
    >
      {children}
    </div>
  );
}

export function FocusedFlow({ children, className = '', ...props }: ComponentPropsWithoutRef<'div'> & { children: ReactNode }) {
  return <div className={`focused-flow-clearance ${className}`} {...props}>{children}</div>;
}
