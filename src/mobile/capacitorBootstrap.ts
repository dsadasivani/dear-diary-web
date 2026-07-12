import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import { Keyboard, KeyboardResize } from '@capacitor/keyboard';
import { SplashScreen } from '@capacitor/splash-screen';
import { StatusBar, Style } from '@capacitor/status-bar';

const BACK_EVENT = 'dear-diary:android-back';

export const isCapacitorNative = (): boolean => Capacitor.isNativePlatform();

export const setupCapacitorBootstrap = async (): Promise<void> => {
  if (!isCapacitorNative()) {
    return;
  }

  if (Capacitor.getPlatform() === 'ios') {
    try {
      await Keyboard.setResizeMode({ mode: KeyboardResize.Body });
    } catch (error) {
      console.warn('Keyboard resize configuration failed:', error);
    }
  }

  await syncNativeStatusBar(document.documentElement.classList.contains('dark') ? 'dark' : 'light');

  CapacitorApp.addListener('backButton', () => {
    window.dispatchEvent(new CustomEvent(BACK_EVENT));
  });

  requestAnimationFrame(() => {
    SplashScreen.hide().catch(error => {
      console.warn('Splash screen hide failed:', error);
    });
  });
};

export const syncNativeStatusBar = async (theme: 'light' | 'dark'): Promise<void> => {
  if (!isCapacitorNative()) {
    return;
  }

  try {
    await StatusBar.setStyle({ style: theme === 'dark' ? Style.Dark : Style.Light });
    await StatusBar.setBackgroundColor({ color: theme === 'dark' ? '#131012' : '#FCFAF7' });
  } catch (error) {
    console.warn('Status bar configuration failed:', error);
  }
};

export const addNativeBackListener = (handler: () => void): (() => void) => {
  window.addEventListener(BACK_EVENT, handler);
  return () => window.removeEventListener(BACK_EVENT, handler);
};

export const addNativeAppStateListener = (
  handler: (state: { isActive: boolean }) => void,
): (() => void) => {
  if (!isCapacitorNative()) return () => undefined;
  let listener: PluginListenerHandle | null = null;
  let disposed = false;
  void CapacitorApp.addListener('appStateChange', handler).then(handle => {
    if (disposed) {
      void handle.remove();
      return;
    }
    listener = handle;
  });
  return () => {
    disposed = true;
    void listener?.remove();
  };
};

export const addNativeUrlOpenListener = (
  handler: (event: { url: string }) => void,
): (() => void) => {
  if (!isCapacitorNative()) return () => undefined;
  let listener: PluginListenerHandle | null = null;
  let disposed = false;
  void CapacitorApp.addListener('appUrlOpen', handler).then(handle => {
    if (disposed) {
      void handle.remove();
      return;
    }
    listener = handle;
  });
  return () => {
    disposed = true;
    void listener?.remove();
  };
};

export const getNativeLaunchUrl = async (): Promise<string | null> => {
  if (!isCapacitorNative()) return null;
  const launchUrl = await CapacitorApp.getLaunchUrl();
  return launchUrl?.url || null;
};

export const exitNativeApp = async (): Promise<void> => {
  if (!isCapacitorNative()) {
    return;
  }
  await CapacitorApp.exitApp();
};
