import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

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
  ) return 'vendor-native';
  if (
    id.includes('/crypto-js/') ||
    id.includes('/dompurify/') ||
    id.includes('/fflate/')
  ) return 'vendor-storage';
  return undefined;
};

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    build: {
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
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
