import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { IconoirProvider } from 'iconoir-react';
import '@fontsource/source-serif-4/400.css';
import '@fontsource/source-serif-4/400-italic.css';
import '@fontsource/source-serif-4/600.css';
import '@fontsource/dm-sans/300.css';
import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/500.css';
import '@fontsource/dm-sans/600.css';
import '@fontsource/dm-sans/700.css';
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
import { installManualPerformanceHooks } from './testing/manualSyncFlowHooks';

setPerformanceTelemetry(createConfiguredTelemetry());
const crashReporter = createConfiguredCrashReporter();
window.addEventListener('error', (event) => crashReporter.capture(event.error));
window.addEventListener('unhandledrejection', (event) => crashReporter.capture(event.reason));

// Apply the local palette before React mounts so bootstrap and lock screens do not flash the default.
applyAccentThemePreference(getLocalAccentThemePreference());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <IconoirProvider iconProps={{ strokeWidth: 1.8 }}>
      <AmbientThemeProvider>
        <AppBootstrap />
      </AmbientThemeProvider>
    </IconoirProvider>
  </StrictMode>,
);

void setupCapacitorBootstrap();
void installManualPerformanceHooks();
