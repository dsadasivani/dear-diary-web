import { App as CapacitorApp } from '@capacitor/app';
import type { PluginListenerHandle } from '@capacitor/core';
import { isNativePlatform } from '../platform';
import { fileStorageService } from '../platform/filesystem';
import { nativeDriveBackupBridge } from '../platform/drive/nativeDriveBackupBridge';
import { diaryRepository } from '../repositories';
import type { DriveBackupSettings, GoogleAccountIdentity } from '../types';
import { BACKUP_SCHEMA_VERSION, createBackupBundle } from './backupSnapshot';
import { bindGoogleRecoveryAccount } from '../domain/security';
import { encryptWithStoredDriveKey } from './backupEncryption';

const STAGED_BACKUP_PATH = 'backups/pending.ddb';
const STAGE_DEBOUNCE_MS = 30_000;

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
};

class BackupCoordinator {
  private initialized = false;
  private stageTimer: ReturnType<typeof setTimeout> | null = null;
  private stagePromise: Promise<void> | null = null;
  private removeRepositoryListener: (() => void) | null = null;
  private appStateListener: PluginListenerHandle | null = null;

  async initialize(): Promise<void> {
    if (this.initialized || !isNativePlatform()) return;
    this.initialized = true;

    const settings = await diaryRepository.getDriveBackupSettings();
    if (settings.linkedGoogleUserId && settings.linkedGoogleEmail) {
      const identity: GoogleAccountIdentity = {
        userId: settings.linkedGoogleUserId,
        email: settings.linkedGoogleEmail,
        displayName: settings.linkedGoogleDisplayName || null,
        linkedAt: settings.linkedAt || Date.now(),
      };
      await nativeDriveBackupBridge.saveLinkedAccount(identity).catch(error => {
        console.warn('Could not migrate the linked Google account to native backup storage:', error);
      });
      const security = await diaryRepository.getSecurityConfig();
      if (!security.linkedGoogleUserId) {
        const binding = bindGoogleRecoveryAccount(security, {
          userId: identity.userId,
          email: identity.email,
        });
        if (binding.ok) await diaryRepository.saveSecurityConfig(binding.config);
      }
    }

    if (settings.schedule) {
      await nativeDriveBackupBridge.configureSchedule(settings.schedule).catch(error => {
        console.warn('Could not configure automatic backup:', error);
      });
    }
    await this.reconcileRuntimeState();

    this.removeRepositoryListener = diaryRepository.subscribeChanges(() => this.scheduleStage());
    this.appStateListener = await CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) void this.stageIfNeeded();
    });
    void this.stageIfNeeded();
  }

  async stageNow(): Promise<void> {
    if (!isNativePlatform()) return;
    if (this.stagePromise) return this.stagePromise;
    this.stagePromise = this.createStage().finally(() => {
      this.stagePromise = null;
    });
    return this.stagePromise;
  }

  async runNow(): Promise<void> {
    await this.stageNow();
    await nativeDriveBackupBridge.runBackupNow();
  }

  async reconcileRuntimeState(): Promise<DriveBackupSettings> {
    const current = await diaryRepository.getDriveBackupSettings();
    if (!isNativePlatform()) return current;
    try {
      const runtime = await nativeDriveBackupBridge.getRuntimeState();
      const merged: DriveBackupSettings = {
        ...current,
        ...runtime,
        schedule: runtime.schedule || current.schedule,
        deviceId: current.deviceId || runtime.deviceId,
        contentRevision: Math.max(current.contentRevision || 0, runtime.contentRevision || 0),
      };
      await diaryRepository.saveDriveBackupSettings(merged);
      return merged;
    } catch (error) {
      console.warn('Could not read native backup status:', error);
      return current;
    }
  }

  private scheduleStage(): void {
    if (this.stageTimer) clearTimeout(this.stageTimer);
    this.stageTimer = setTimeout(() => {
      this.stageTimer = null;
      void this.stageIfNeeded();
    }, STAGE_DEBOUNCE_MS);
  }

  private async stageIfNeeded(): Promise<void> {
    const settings = await diaryRepository.getDriveBackupSettings();
    if (!settings.linkedGoogleUserId || settings.cloudWriteBlocked) return;
    if ((settings.stagedContentRevision || 0) >= (settings.contentRevision || 0)) return;
    await this.stageNow().catch(error => console.warn('Automatic backup staging failed:', error));
  }

  private async createStage(): Promise<void> {
    const settings = await diaryRepository.getDriveBackupSettings();
    if (!settings.deviceId) throw new Error('This device does not have a backup identity.');
    const bundle = await createBackupBundle({
      deviceId: settings.deviceId,
      contentRevision: settings.contentRevision || 0,
      parentBackupFileId: settings.parentBackupFileId || settings.lastBackupFileId,
      schedule: settings.schedule,
    });
    const encrypted = settings.encryption?.enabled === true;
    if (encrypted && !settings.linkedGoogleUserId) throw new Error('Encrypted Drive backup requires a linked Google account.');
    const stagedBytes = encrypted
      ? await encryptWithStoredDriveKey(bundle.bytes, settings.linkedGoogleUserId!)
      : bundle.bytes;
    await fileStorageService.writeBase64Atomic(STAGED_BACKUP_PATH, bytesToBase64(stagedBytes));
    await nativeDriveBackupBridge.stageBackup({
      path: STAGED_BACKUP_PATH,
      sizeBytes: stagedBytes.length,
      schemaVersion: BACKUP_SCHEMA_VERSION,
      contentRevision: bundle.manifest.contentRevision || 0,
      deviceId: settings.deviceId,
      parentBackupFileId: bundle.manifest.parentBackupFileId,
      encrypted,
      encryptionKeyId: encrypted ? settings.encryption?.keyId : undefined,
    });
    await diaryRepository.saveDriveBackupSettings({
      ...settings,
      stagedContentRevision: bundle.manifest.contentRevision || 0,
    });
  }
}

export const backupCoordinator = new BackupCoordinator();
