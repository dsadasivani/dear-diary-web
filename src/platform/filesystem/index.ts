import { isNativePlatform } from '../platform';
import type { FileStorageService } from './FileStorageService';
import { MobileFileStorageService } from './mobileFileStorageService';
import { WebFileStorageService } from './webFileStorageService';

export type { FileStorageService, StoredFile, StoredFileEntry } from './FileStorageService';

export const fileStorageService: FileStorageService = isNativePlatform()
  ? new MobileFileStorageService()
  : new WebFileStorageService();
