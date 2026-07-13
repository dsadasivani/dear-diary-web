import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import AppBootstrap from './AppBootstrap.tsx';
import './index.css';
import { setupCapacitorBootstrap } from './mobile/capacitorBootstrap';
import { createConfiguredCrashReporter, createConfiguredTelemetry } from './sync/config';
import { setPerformanceTelemetry } from './utils/performance';

setPerformanceTelemetry(createConfiguredTelemetry());
const crashReporter = createConfiguredCrashReporter();
window.addEventListener('error', event => crashReporter.capture(event.error));
window.addEventListener('unhandledrejection', event => crashReporter.capture(event.reason));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppBootstrap />
  </StrictMode>,
);

void setupCapacitorBootstrap();
