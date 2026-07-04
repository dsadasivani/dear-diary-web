export interface StoredFile {
  uri: string;
  webPath?: string;
}

export interface FileStorageService {
  writeBase64(path: string, base64Data: string): Promise<StoredFile>;
  readBase64(path: string): Promise<string | null>;
}
