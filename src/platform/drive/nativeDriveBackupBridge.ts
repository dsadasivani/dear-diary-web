import { registerPlugin } from '@capacitor/core';
import type {
  BackupFileSummary,
  BackupSchedulePreference,
  DriveBackupSettings,
  GoogleAccountIdentity,
  GoogleConnectionState,
} from '../../types';

export interface NativeAuthorizationResult extends GoogleConnectionState {
  accessToken: string | null;
}

export interface StagedBackupInput {
  path: string;
  sizeBytes: number;
  schemaVersion: number;
  contentRevision: number;
  deviceId: string;
  parentBackupFileId?: string;
}

export interface NativeDriveBackupBridge {
  saveLinkedAccount(account: GoogleAccountIdentity): Promise<void>;
  getConnectionState(): Promise<GoogleConnectionState>;
  authorize(options: { interactive: boolean }): Promise<NativeAuthorizationResult>;
  disconnect(): Promise<void>;
  configureSchedule(schedule: BackupSchedulePreference): Promise<void>;
  stageBackup(input: StagedBackupInput): Promise<void>;
  runBackupNow(): Promise<void>;
  getRuntimeState(): Promise<DriveBackupSettings>;
  getNetworkState(): Promise<{ connected: boolean; metered: boolean }>;
  setCloudWriteBlocked(options: { blocked: boolean }): Promise<void>;
}

export const nativeDriveBackupBridge = registerPlugin<NativeDriveBackupBridge>('DearDiaryDrive');

export type { BackupFileSummary };
