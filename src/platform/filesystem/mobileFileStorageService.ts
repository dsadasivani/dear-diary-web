import { Directory, Filesystem } from '@capacitor/filesystem';
import type { FileStorageService, StoredFile } from './FileStorageService';

export class MobileFileStorageService implements FileStorageService {
  async writeBase64(path: string, base64Data: string): Promise<StoredFile> {
    const result = await Filesystem.writeFile({
      path,
      data: base64Data,
      directory: Directory.Data,
      recursive: true,
    });
    return { uri: result.uri };
  }

  async readBase64(path: string): Promise<string | null> {
    const result = await Filesystem.readFile({
      path,
      directory: Directory.Data,
    });
    return typeof result.data === 'string' ? result.data : null;
  }
}
