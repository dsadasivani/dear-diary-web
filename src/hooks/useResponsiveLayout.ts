import { useEffect, useState } from 'react';
import type { ResponsiveLayout } from '../types';

const getLayout = (): ResponsiveLayout => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'mobile';
  if (window.matchMedia('(min-width: 1200px)').matches) return 'desktop';
  if (window.matchMedia('(min-width: 768px)').matches) return 'tablet';
  return 'mobile';
};

export default function useResponsiveLayout(): ResponsiveLayout {
  const [layout, setLayout] = useState<ResponsiveLayout>(getLayout);

  useEffect(() => {
    const medium = window.matchMedia('(min-width: 768px)');
    const large = window.matchMedia('(min-width: 1200px)');
    const update = () => setLayout(getLayout());
    medium.addEventListener('change', update);
    large.addEventListener('change', update);
    return () => {
      medium.removeEventListener('change', update);
      large.removeEventListener('change', update);
    };
  }, []);

  return layout;
}
