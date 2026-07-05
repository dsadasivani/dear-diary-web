export interface StoredFile {
  uri: string;
  webPath?: string;
}

export interface StoredFileEntry {
  name: string;
  path: string;
  modifiedAt?: number;
  size?: number;
}

export interface FileStorageService {
  writeBase64(path: string, base64Data: string): Promise<StoredFile>;
  writeBase64Atomic(path: string, base64Data: string): Promise<StoredFile>;
  readBase64(path: string): Promise<string | null>;
  list(path: string): Promise<StoredFileEntry[]>;
  delete(path: string): Promise<void>;
}
