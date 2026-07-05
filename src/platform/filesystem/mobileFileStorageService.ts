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

  async writeBase64Atomic(path: string, base64Data: string): Promise<StoredFile> {
    const temporaryPath = `${path}.tmp`;
    await Filesystem.writeFile({
      path: temporaryPath,
      data: base64Data,
      directory: Directory.Data,
      recursive: true,
    });
    await Filesystem.deleteFile({ path, directory: Directory.Data }).catch(() => undefined);
    await Filesystem.rename({
      from: temporaryPath,
      to: path,
      directory: Directory.Data,
      toDirectory: Directory.Data,
    });
    const result = await Filesystem.getUri({ path, directory: Directory.Data });
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
