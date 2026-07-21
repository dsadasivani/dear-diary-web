import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import AppBootstrap from './AppBootstrap.tsx';
import './index.css';
import { setupCapacitorBootstrap } from './mobile/capacitorBootstrap';
import { createConfiguredCrashReporter, createConfiguredTelemetry } from './sync/config';
import { setPerformanceTelemetry } from './utils/performance';
import { AmbientThemeProvider } from './design/ambientTheme';
import {
  applyAccentThemePreference,
  getLocalAccentThemePreference,
} from './utils/accentPreference';

setPerformanceTelemetry(createConfiguredTelemetry());
const crashReporter = createConfiguredCrashReporter();
window.addEventListener('error', (event) => crashReporter.capture(event.error));
window.addEventListener('unhandledrejection', (event) => crashReporter.capture(event.reason));

// Apply the local palette before React mounts so bootstrap and lock screens do not flash the default.
applyAccentThemePreference(getLocalAccentThemePreference());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AmbientThemeProvider>
      <AppBootstrap />
    </AmbientThemeProvider>
  </StrictMode>,
);

void setupCapacitorBootstrap();
