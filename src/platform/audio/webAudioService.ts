import type { AudioService, RecordingSupport } from './AudioService';

export class WebAudioService implements AudioService {
  getRecordingSupport(): RecordingSupport {
    return {
      mediaRecorder: typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia,
      speechRecognition:
        typeof window !== 'undefined' &&
        ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window),
    };
  }
}
