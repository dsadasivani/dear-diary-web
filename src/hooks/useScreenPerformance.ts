import { useEffect, useRef } from 'react';
import { recordPerformanceMeasurement } from '../utils/performance';

const now = (): number => (
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
);

export const useScreenPerformance = (screenName: string): void => {
  const startedAt = useRef(now());

  useEffect(() => {
    const durationMs = now() - startedAt.current;
    recordPerformanceMeasurement(`react.screen.mount.${screenName}`, durationMs);
  }, [screenName]);
};
