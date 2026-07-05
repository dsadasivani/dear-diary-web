import { BackupFileSummary, DriveBackupSettings, GoogleAccountSession } from '../types';
import { createBackupBundle, restoreBackupBundle } from './backupSnapshot';
import { restoreGoogleDriveSession, startGoogleAuth } from './googleAuth';
import { diaryRepository } from '../repositories';
import { backupCoordinator } from './backupCoordinator';
import { nativeDriveBackupBridge } from '../platform/drive/nativeDriveBackupBridge';

const DRIVE_FILES_ENDPOINT = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD_ENDPOINT = 'https://www.googleapis.com/upload/drive/v3/files';
const BACKUP_MIME_TYPE = 'application/vnd.deardiary.backup+zip';
const BACKUP_NAME_PREFIX = 'deardiary-backup-';
const MAX_BACKUPS_TO_KEEP = 5;

const BACKUP_ERROR_MESSAGES: Record<string, string> = {
  reauthorization_required: 'Google Drive authorization needs to be renewed from Profile.',
  newer_backup_on_another_device: 'A newer backup is active on another device. Restore it before replacing cloud data.',
  staged_file_missing: 'The staged backup file is missing. Try again.',
  temporary_drive_error: 'Google Drive is temporarily unavailable. Android will retry the backup.',
  refreshing_authorization: 'Google authorization expired. Android is refreshing it and will retry.',
  restarting_upload: 'The previous upload session expired. Android is starting a fresh upload.',
  drive_api_disabled: 'Google Drive API is not enabled for this OAuth project.',
  drive_quota_exceeded: 'This Google Drive account does not have enough storage for the backup.',
  drive_request_failed: 'Google Drive rejected the backup request.',
  backup_failed: 'The backup could not be completed.',
};

export const getDriveBackupErrorMessage = (code?: string | null): string => (
  code ? BACKUP_ERROR_MESSAGES[code] || 'The last automatic backup could not complete.' : ''
);

export class DriveAuthorizationError extends Error {
  readonly status: number;
  readonly requiresReconnect: boolean;

  constructor(message: string, status: number, requiresReconnect: boolean = true) {
    super(message);
    this.name = 'DriveAuthorizationError';
    this.status = status;
    this.requiresReconnect = requiresReconnect;
  }
}

export const isDriveAuthorizationError = (error: unknown): error is DriveAuthorizationError => (
  error instanceof DriveAuthorizationError
);

const requireAccessToken = (session: GoogleAccountSession): string => {
  if (!session.accessToken) {
    throw new Error('Reconnect Google Drive before backing up. The current session has no Drive access token.');
  }
  return session.accessToken;
};

const readDriveErrorDetail = async (response: Response): Promise<{ message: string; reason: string; raw: string }> => {
  const raw = await response.text().catch(() => '');
  try {
    const payload = JSON.parse(raw);
    const message = payload?.error?.message || raw;
    const reason = payload?.error?.errors?.[0]?.reason || payload?.error?.status || '';
    return { message, reason, raw };
  } catch {
    return { message: raw, reason: '', raw };
  }
};

const throwDriveResponseError = async (response: Response): Promise<never> => {
  const detail = await readDriveErrorDetail(response);
  const normalized = `${detail.reason} ${detail.message} ${detail.raw}`.toLowerCase();

  if (response.status === 401) {
    throw new DriveAuthorizationError('Google Drive authorization expired. Reconnect Google Drive and try again.', response.status);
  }

  if (response.status === 403) {
    if (
      normalized.includes('accessnotconfigured') ||
      normalized.includes('service_disabled') ||
      normalized.includes('api has not been used') ||
      normalized.includes('drive api has not been used')
    ) {
      throw new DriveAuthorizationError(
        'Google Drive API is not enabled for this OAuth project. Enable Google Drive API in Google Cloud Console, rebuild, and try again.',
        response.status,
        false,
      );
    }

    if (
      normalized.includes('insufficient') ||
      normalized.includes('scope') ||
      normalized.includes('permission')
    ) {
      throw new DriveAuthorizationError(
        'Google Drive backup permission is missing or was denied. Reconnect Google Drive and approve app data access.',
        response.status,
      );
    }

    throw new DriveAuthorizationError(
      `Google Drive denied the request. ${detail.message || 'Reconnect Google Drive and try again.'}`,
      response.status,
      false,
    );
  }

  if (response.status === 429) {
    throw new Error('Google Drive is rate limiting backup requests. Wait a few minutes and try again.');
  }

  throw new Error(`Google Drive request failed (${response.status}). ${detail.message || detail.raw}`);
};

const authorizedFetch = async (
  session: GoogleAccountSession,
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> => {
  const send = (activeSession: GoogleAccountSession) => {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${requireAccessToken(activeSession)}`);
    return fetch(input, { ...init, headers });
  };

  let response = await send(session);
  if (response.status === 401) {
    const refreshed = await restoreGoogleDriveSession(false).catch(() => null);
    if (refreshed?.userId === session.userId && refreshed.accessToken) {
      response = await send(refreshed);
    }
  }

  if (!response.ok) {
    await throwDriveResponseError(response);
  }

  return response;
};

const toBackupFileSummary = (file: any): BackupFileSummary => ({
  id: file.id,
  name: file.name,
  createdTime: file.createdTime,
  modifiedTime: file.modifiedTime,
  size: file.size ? Number(file.size) : undefined,
  appProperties: file.appProperties || undefined,
});

export const connectGoogleDrive = async (): Promise<GoogleAccountSession> => (
  startGoogleAuth('backup')
);

export const listDriveBackups = async (session: GoogleAccountSession): Promise<BackupFileSummary[]> => {
  const query = encodeURIComponent(`name contains '${BACKUP_NAME_PREFIX}' and trashed = false`);
  const fields = encodeURIComponent('files(id,name,createdTime,modifiedTime,size,appProperties)');
  const url = `${DRIVE_FILES_ENDPOINT}?spaces=appDataFolder&q=${query}&fields=${fields}&orderBy=createdTime desc`;
  const response = await authorizedFetch(session, url);
  const payload = await response.json();
  return (payload.files || []).map(toBackupFileSummary);
};

const initiateResumableUpload = async (
  session: GoogleAccountSession,
  name: string,
  size: number,
): Promise<string> => {
  const params = new URLSearchParams({
    uploadType: 'resumable',
    fields: 'id,name,createdTime,modifiedTime,size',
  });
  const response = await authorizedFetch(session, `${DRIVE_UPLOAD_ENDPOINT}?${params.toString()}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': BACKUP_MIME_TYPE,
      'X-Upload-Content-Length': String(size),
    },
    body: JSON.stringify({
      name,
      mimeType: BACKUP_MIME_TYPE,
      parents: ['appDataFolder'],
      appProperties: {
        app: 'dear-diary',
        backupSchemaVersion: '1',
      },
    }),
  });

  const uploadUrl = response.headers.get('Location');
  if (!uploadUrl) {
    throw new Error('Google Drive did not return a resumable upload URL.');
  }
  return uploadUrl;
};

const uploadBackupBytes = async (
  session: GoogleAccountSession,
  uploadUrl: string,
  bytes: Uint8Array,
): Promise<BackupFileSummary> => {
  const headers = new Headers({
    'Content-Type': BACKUP_MIME_TYPE,
  });
  headers.set('Authorization', `Bearer ${requireAccessToken(session)}`);

  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers,
    body: bytes,
  });

  if (!response.ok) {
    if (response.status >= 500) {
      throw new Error('Google Drive upload was interrupted. Please try the backup again.');
    }
    await throwDriveResponseError(response);
  }

  return toBackupFileSummary(await response.json());
};

const pruneOldBackups = async (
  session: GoogleAccountSession,
  backups: BackupFileSummary[],
): Promise<void> => {
  const oldBackups = backups
    .slice()
    .sort((left, right) => (Date.parse(right.createdTime || '') || 0) - (Date.parse(left.createdTime || '') || 0))
    .slice(MAX_BACKUPS_TO_KEEP);

  await Promise.all(oldBackups.map(backup => deleteDriveBackup(session, backup.id)));
};

export const createDriveBackup = async (
  _session: GoogleAccountSession,
): Promise<{ file: BackupFileSummary; settings: DriveBackupSettings }> => {
  const before = await diaryRepository.getDriveBackupSettings();
  const previousBackupAt = before.lastBackupAt || 0;
  await backupCoordinator.runNow();

  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 750));
    const settings = await backupCoordinator.reconcileRuntimeState();
    if ((settings.lastBackupAt || 0) > previousBackupAt && settings.lastBackupFileId) {
      return {
        file: {
          id: settings.lastBackupFileId,
          name: 'Dear Diary backup',
          createdTime: new Date(settings.lastBackupAt!).toISOString(),
          size: settings.lastBackupSizeBytes,
        },
        settings,
      };
    }
    if (settings.lastErrorCode) {
      throw new Error(getDriveBackupErrorMessage(settings.lastErrorCode));
    }
  }
  throw new Error('The backup is still pending. It will continue when Android permits background work.');
};

export const restoreDriveBackup = async (
  session: GoogleAccountSession,
  fileId: string,
): Promise<DriveBackupSettings> => {
  const response = await authorizedFetch(session, `${DRIVE_FILES_ENDPOINT}/${encodeURIComponent(fileId)}?alt=media`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  await restoreBackupBundle(bytes);
  const currentSettings = await diaryRepository.getDriveBackupSettings();
  const settings: DriveBackupSettings = {
    ...currentSettings,
    linkedGoogleUserId: session.userId,
    linkedGoogleEmail: session.email,
    lastRestoreAt: Date.now(),
    lastBackupFileId: fileId,
    parentBackupFileId: fileId,
    cloudWriteBlocked: false,
  };
  await diaryRepository.saveDriveBackupSettings(settings);
  await nativeDriveBackupBridge.setCloudWriteBlocked({ blocked: false });
  await backupCoordinator.runNow();
  return settings;
};

export const restoreLatestValidDriveBackup = async (
  session: GoogleAccountSession,
): Promise<DriveBackupSettings> => {
  const backups = await listDriveBackups(session);
  let lastError: unknown = null;
  for (const backup of backups.slice(0, MAX_BACKUPS_TO_KEEP)) {
    try {
      return await restoreDriveBackup(session, backup.id);
    } catch (error) {
      if (isDriveAuthorizationError(error)) throw error;
      lastError = error;
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new Error('No compatible Google Drive backup was found.');
};

export const deleteDriveBackup = async (
  session: GoogleAccountSession,
  fileId: string,
): Promise<void> => {
  await authorizedFetch(session, `${DRIVE_FILES_ENDPOINT}/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
  });
};
