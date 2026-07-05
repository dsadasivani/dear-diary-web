import type { FileStorageService, StoredFile } from './FileStorageService';

export class WebFileStorageService implements FileStorageService {
  async writeBase64(_path: string, base64Data: string): Promise<StoredFile> {
    return { uri: base64Data, webPath: base64Data };
  }

  async writeBase64Atomic(path: string, base64Data: string): Promise<StoredFile> {
    return this.writeBase64(path, base64Data);
  }

  async readBase64(path: string): Promise<string | null> {
    return path.startsWith('data:') ? path : null;
  }
}
