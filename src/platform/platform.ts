import { Capacitor } from '@capacitor/core';

export type DearDiaryPlatform = 'android' | 'ios' | 'web';

export const isNativePlatform = (): boolean => Capacitor.isNativePlatform();

export const getPlatformName = (): DearDiaryPlatform => {
  const platform = Capacitor.getPlatform();
  if (platform === 'android' || platform === 'ios') {
    return platform;
  }
  return 'web';
};

export const isAndroid = (): boolean => getPlatformName() === 'android';

export const isIOS = (): boolean => getPlatformName() === 'ios';

export const isWeb = (): boolean => !isNativePlatform();
