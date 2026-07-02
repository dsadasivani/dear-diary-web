import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.deardiary.app',
  appName: 'Dear Diary',
  webDir: 'dist',
  android: {
    loggingBehavior: 'none',
    webContentsDebuggingEnabled: false,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 0,
    },
  },
};

export default config;
