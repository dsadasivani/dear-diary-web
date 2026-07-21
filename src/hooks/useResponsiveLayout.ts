import { useEffect, useState } from 'react';
import type { ResponsiveLayout } from '../types';

export const RESPONSIVE_BREAKPOINTS = {
  tablet: 768,
  desktop: 1200,
} as const;

const tabletQuery = `(min-width: ${RESPONSIVE_BREAKPOINTS.tablet}px)`;
const desktopQuery = `(min-width: ${RESPONSIVE_BREAKPOINTS.desktop}px)`;

export const getResponsiveLayout = (): ResponsiveLayout => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'mobile';
  if (window.matchMedia(desktopQuery).matches) return 'desktop';
  if (window.matchMedia(tabletQuery).matches) return 'tablet';
  return 'mobile';
};

export default function useResponsiveLayout(): ResponsiveLayout {
  const [layout, setLayout] = useState<ResponsiveLayout>(getResponsiveLayout);

  useEffect(() => {
    const medium = window.matchMedia(tabletQuery);
    const large = window.matchMedia(desktopQuery);
    const update = () => setLayout(getResponsiveLayout());
    const listen = (query: MediaQueryList) => {
      if (typeof query.addEventListener === 'function') query.addEventListener('change', update);
      else query.addListener(update);
    };
    const unlisten = (query: MediaQueryList) => {
      if (typeof query.removeEventListener === 'function')
        query.removeEventListener('change', update);
      else query.removeListener(update);
    };
    listen(medium);
    listen(large);
    return () => {
      unlisten(medium);
      unlisten(large);
    };
  }, []);

  return layout;
}
