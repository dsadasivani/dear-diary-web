import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig, loadEnv } from 'vite';

const manualChunks = (id: string): string | undefined => {
  if (!id.includes('node_modules')) return undefined;
  if (id.includes('/react/') || id.includes('/react-dom/')) return 'vendor-react';
  if (id.includes('/motion/')) return 'vendor-motion';
  if (id.includes('/lucide-react/')) return 'vendor-icons';
  if (id.includes('/@supabase/')) return 'vendor-supabase';
  if (
    id.includes('/@capacitor/') ||
    id.includes('/@capacitor-community/') ||
    id.includes('/@capawesome/') ||
    id.includes('/@capgo/') ||
    id.includes('/@independo/') ||
    id.includes('/@aparajita/')
  )
    return 'vendor-native';
  if (id.includes('/crypto-js/') || id.includes('/dompurify/') || id.includes('/fflate/'))
    return 'vendor-storage';
  return undefined;
};

export default defineConfig(({ mode }) => {
  const fileEnvironment = loadEnv(mode, process.cwd(), '');
  const environment = { ...fileEnvironment, ...process.env };
  const includeTestHooks =
    environment.VITE_DEAR_DIARY_E2E === '1' || environment.VITE_ENABLE_MD_FLOW_HOOKS === 'true';
  const disableHmr = environment.DISABLE_HMR === 'true' || environment.VITE_DEAR_DIARY_E2E === '1';
  return {
    plugins: [react(), tailwindcss()],
    build: {
      sourcemap: false,
      rollupOptions: {
        output: {
          manualChunks,
        },
      },
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
      ...(includeTestHooks
        ? {}
        : {
            alias: [
              { find: '@', replacement: path.resolve(__dirname, '.') },
              {
                find: /^\.\.?\/testing\/e2eRepositorySeed$/,
                replacement: '/src/testing/noopE2eRepositorySeed.ts',
              },
              {
                find: /^\.\.?\/testing\/manualSyncFlowHooks$/,
                replacement: '/src/testing/noopManualSyncFlowHooks.ts',
              },
            ],
          }),
    },
    define: {
      'import.meta.env.VITE_APP_VERSION': JSON.stringify(
        environment.VITE_APP_VERSION || environment.npm_package_version || '1.0.0',
      ),
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify; file watching is disabled to prevent flickering during agent edits.
      hmr: !disableHmr,
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: disableHmr ? null : {},
    },
  };
});
