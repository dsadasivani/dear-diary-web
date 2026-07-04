import { isNativePlatform } from '../platform';
import type { AudioService } from './AudioService';
import { MobileAudioService } from './mobileAudioService';
import { WebAudioService } from './webAudioService';

export type { AudioService, RecordingSupport } from './AudioService';

export const audioService: AudioService = isNativePlatform()
  ? new MobileAudioService()
  : new WebAudioService();
