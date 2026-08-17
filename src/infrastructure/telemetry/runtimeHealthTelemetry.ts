import type { Telemetry } from './Telemetry';

interface MemoryPerformance extends Performance {
  memory?: {
    usedJSHeapSize: number;
    jsHeapSizeLimit: number;
  };
}

export const installRuntimeHealthTelemetry = (telemetry: Telemetry): (() => void) => {
  let observer: PerformanceObserver | undefined;
  if (typeof PerformanceObserver !== 'undefined') {
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          telemetry.counter('deardiary.ui.long_task.count', 1);
          telemetry.histogram('deardiary.ui.long_task.duration_ms', entry.duration);
        }
      });
      observer.observe({ entryTypes: ['longtask'] });
    } catch {
      observer = undefined;
    }
  }

  const sampleMemory = () => {
    const memory =
      typeof performance === 'undefined'
        ? undefined
        : (performance as MemoryPerformance).memory;
    if (!memory || memory.jsHeapSizeLimit <= 0) return;
    const utilization = memory.usedJSHeapSize / memory.jsHeapSizeLimit;
    telemetry.gauge('deardiary.memory.js_heap_used_bytes', memory.usedJSHeapSize);
    telemetry.gauge('deardiary.memory.js_heap_utilization_ratio', utilization);
    if (utilization >= 0.8) telemetry.event('deardiary.memory.pressure', 'WARN');
  };
  sampleMemory();
  const memoryTimer = setInterval(sampleMemory, 60_000);
  return () => {
    observer?.disconnect();
    clearInterval(memoryTimer);
  };
};
