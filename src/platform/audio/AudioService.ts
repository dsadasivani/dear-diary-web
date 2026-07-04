export interface RecordingSupport {
  mediaRecorder: boolean;
  speechRecognition: boolean;
}

export interface AudioService {
  getRecordingSupport(): RecordingSupport;
}
