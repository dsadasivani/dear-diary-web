import type { CapacitorConfig } from '@capacitor/cli';

const nativeDebug = process.env.CAPACITOR_DEBUG === 'true';

const config: CapacitorConfig = {
  appId: 'com.deardiary.app',
  appName: 'Dear Diary',
  webDir: 'dist',
  android: {
    loggingBehavior: nativeDebug ? 'debug' : 'none',
    webContentsDebuggingEnabled: nativeDebug,
  },
  plugins: {
    CapacitorSQLite: {
      androidIsEncryption: true,
      iosIsEncryption: true,
      iosDatabaseLocation: 'Library/CapacitorDatabase',
      iosKeychainPrefix: 'dear-diary-sqlite',
    },
    SplashScreen: {
      launchShowDuration: 0,
    },
  },
};

export default config;
