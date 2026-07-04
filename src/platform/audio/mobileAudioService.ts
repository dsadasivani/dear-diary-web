import type { AudioService, RecordingSupport } from './AudioService';

export class MobileAudioService implements AudioService {
  getRecordingSupport(): RecordingSupport {
    return {
      mediaRecorder: true,
      speechRecognition: true,
    };
  }
}
