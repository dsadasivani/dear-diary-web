import type { CapacitorConfig } from '@capacitor/cli';

const webViewDebug =
  process.env.CAPACITOR_WEBVIEW_DEBUG === 'true' || process.env.CAPACITOR_DEBUG === 'true';
const bridgeLogging = process.env.CAPACITOR_BRIDGE_LOGGING === 'true';
const isReleaseBuild = process.env.DEAR_DIARY_RELEASE_BUILD === 'true';

if (isReleaseBuild && (webViewDebug || bridgeLogging)) {
  throw new Error('Release builds forbid WebView debugging and Capacitor bridge logging.');
}

const config: CapacitorConfig = {
  appId: 'com.deardiary.app',
  appName: 'Dear Diary',
  webDir: 'dist',
  android: {
    loggingBehavior: bridgeLogging ? 'debug' : 'none',
    webContentsDebuggingEnabled: webViewDebug,
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
