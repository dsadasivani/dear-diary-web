import type { GoogleAccountSession, SyncObjectKind } from '../types';
import { measureAsync } from '../utils/performance';
import { executeRequest } from '../infrastructure/http/executeRequest';
import { mapDriveError } from './errors';

const DRIVE_FILES_ENDPOINT = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD_ENDPOINT = 'https://www.googleapis.com/upload/drive/v3/files';
const DRIVE_ABOUT_ENDPOINT = 'https://www.googleapis.com/drive/v3/about';
export const RESUMABLE_UPLOAD_THRESHOLD_BYTES = 5 * 1024 * 1024;

const SYNC_MIME_TYPES: Record<SyncObjectKind, string> = {
  event: 'application/vnd.deardiary.event',
  media: 'application/vnd.deardiary.media',
  snapshot: 'application/vnd.deardiary.snapshot',
  key_package: 'application/vnd.deardiary.key-package',
  manifest: 'application/vnd.deardiary.manifest',
  partition_snapshot: 'application/vnd.deardiary.partition-snapshot',
  thumbnail: 'application/vnd.deardiary.thumbnail',
};

export interface DriveSyncObjectSummary {
  id: string;
  name: string;
  createdTime?: string;
  modifiedTime?: string;
  size?: number;
  appProperties?: Record<string, string>;
}

export interface DriveStorageQuota {
  limit?: number;
  usage?: number;
  usageInDrive?: number;
  usageInDriveTrash?: number;
}

export interface UploadDriveSyncObjectInput {
  session: GoogleAccountSession;
  name: string;
  objectKind: SyncObjectKind;
  bytes: Uint8Array;
  appProperties?: Record<string, string | number | boolean | undefined | null>;
}

const requireDriveAccessToken = (session: GoogleAccountSession): string => {
  if (!session.accessToken) {
    throw new Error('Google Drive access is required before creating synced diary objects.');
  }
  return session.accessToken;
};

const driveRequest = (
  operation: 'upload' | 'download' | 'delete' | 'list',
  url: string,
  init: RequestInit = {},
  isSuccessfulResponse?: (response: Response) => boolean,
): Promise<Response> =>
  executeRequest({
    request: ({ signal }) => fetch(url, { ...init, signal }),
    mapError: (error) => mapDriveError(error, operation),
    isSuccessfulResponse,
  });

const toAppProperties = (
  objectKind: SyncObjectKind,
  appProperties: UploadDriveSyncObjectInput['appProperties'] = {},
): Record<string, string> => {
  const normalized: Record<string, string> = {
    app: 'dear-diary',
    syncSchemaVersion: '1',
    objectKind,
  };
  Object.entries(appProperties).forEach(([key, value]) => {
    if (value !== undefined && value !== null) normalized[key] = String(value);
  });
  return normalized;
};

const toSummary = (file: any): DriveSyncObjectSummary => ({
  id: file.id,
  name: file.name,
  createdTime: file.createdTime,
  modifiedTime: file.modifiedTime,
  size: file.size ? Number(file.size) : undefined,
  appProperties: file.appProperties || undefined,
});

export const uploadDriveSyncObject = async ({
  session,
  name,
  objectKind,
  bytes,
  appProperties,
}: UploadDriveSyncObjectInput): Promise<DriveSyncObjectSummary> => {
  return measureAsync(
    'sync.drive.upload',
    async () => {
      const metadata = {
        name,
        mimeType: SYNC_MIME_TYPES[objectKind],
        parents: ['appDataFolder'],
        appProperties: toAppProperties(objectKind, appProperties),
      };
      if (bytes.byteLength > RESUMABLE_UPLOAD_THRESHOLD_BYTES) {
        return uploadDriveSyncObjectResumable(session, metadata, objectKind, bytes);
      }
      const delimiter = `dear-diary-${crypto.randomUUID()}`;
      const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));
      const prefix = new TextEncoder().encode(
        `--${delimiter}\r\n` + 'Content-Type: application/json; charset=UTF-8\r\n\r\n',
      );
      const middle = new TextEncoder().encode(
        `\r\n--${delimiter}\r\n` + `Content-Type: ${SYNC_MIME_TYPES[objectKind]}\r\n\r\n`,
      );
      const suffix = new TextEncoder().encode(`\r\n--${delimiter}--`);
      const body = new Uint8Array(
        prefix.length + metadataBytes.length + middle.length + bytes.length + suffix.length,
      );
      let offset = 0;
      [prefix, metadataBytes, middle, bytes, suffix].forEach((part) => {
        body.set(part, offset);
        offset += part.length;
      });

      const fields = encodeURIComponent('id,name,createdTime,modifiedTime,size,appProperties');
      const response = await driveRequest(
        'upload',
        `${DRIVE_UPLOAD_ENDPOINT}?uploadType=multipart&fields=${fields}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${requireDriveAccessToken(session)}`,
            'Content-Type': `multipart/related; boundary=${delimiter}`,
          },
          body,
        },
      );

      return toSummary(await response.json());
    },
    {
      objectKind,
      sizeBytes: bytes.byteLength,
      resumable: bytes.byteLength > RESUMABLE_UPLOAD_THRESHOLD_BYTES,
    },
  );
};

const uploadDriveSyncObjectResumable = async (
  session: GoogleAccountSession,
  metadata: {
    name: string;
    mimeType: string;
    parents: string[];
    appProperties: Record<string, string>;
  },
  objectKind: SyncObjectKind,
  bytes: Uint8Array,
): Promise<DriveSyncObjectSummary> => {
  return measureAsync(
    'sync.drive.upload.resumable',
    async () => {
      const fields = encodeURIComponent('id,name,createdTime,modifiedTime,size,appProperties');
      const start = await driveRequest(
        'upload',
        `${DRIVE_UPLOAD_ENDPOINT}?uploadType=resumable&fields=${fields}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${requireDriveAccessToken(session)}`,
            'Content-Type': 'application/json; charset=UTF-8',
            'X-Upload-Content-Type': SYNC_MIME_TYPES[objectKind],
            'X-Upload-Content-Length': String(bytes.byteLength),
          },
          body: JSON.stringify(metadata),
        },
      );
      const location = start.headers.get('Location');
      if (!location) throw mapDriveError({ code: 'missing_resumable_location' }, 'upload');

      const response = await driveRequest('upload', location, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${requireDriveAccessToken(session)}`,
          'Content-Type': SYNC_MIME_TYPES[objectKind],
          'Content-Length': String(bytes.byteLength),
        },
        body: bytes,
      });
      return toSummary(await response.json());
    },
    { objectKind, sizeBytes: bytes.byteLength },
  );
};

export const downloadDriveSyncObject = async (
  session: GoogleAccountSession,
  fileId: string,
): Promise<Uint8Array> => {
  return measureAsync(
    'sync.drive.download',
    async () => {
      const response = await driveRequest(
        'download',
        `${DRIVE_FILES_ENDPOINT}/${encodeURIComponent(fileId)}?alt=media`,
        {
          headers: { Authorization: `Bearer ${requireDriveAccessToken(session)}` },
        },
      );
      return new Uint8Array(await response.arrayBuffer());
    },
    { hasFileId: Boolean(fileId) },
  );
};

export const deleteDriveSyncObject = async (
  session: GoogleAccountSession,
  fileId: string,
): Promise<void> => {
  await measureAsync(
    'sync.drive.delete',
    async () => {
      await driveRequest(
        'delete',
        `${DRIVE_FILES_ENDPOINT}/${encodeURIComponent(fileId)}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${requireDriveAccessToken(session)}` },
        },
        (response) => response.ok || response.status === 404,
      );
    },
    { hasFileId: Boolean(fileId) },
  );
};

export const listDriveSyncObjects = async (
  session: GoogleAccountSession,
): Promise<DriveSyncObjectSummary[]> => {
  return measureAsync('sync.drive.list', async () => {
    const files: DriveSyncObjectSummary[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        spaces: 'appDataFolder',
        q: "appProperties has { key='app' and value='dear-diary' } and trashed = false",
        fields: 'nextPageToken,files(id,name,createdTime,modifiedTime,size,appProperties)',
        pageSize: '1000',
      });
      if (pageToken) params.set('pageToken', pageToken);
      const response = await driveRequest('list', `${DRIVE_FILES_ENDPOINT}?${params.toString()}`, {
        headers: { Authorization: `Bearer ${requireDriveAccessToken(session)}` },
      });
      const payload = await response.json();
      files.push(...(payload.files || []).map(toSummary));
      pageToken = payload.nextPageToken || undefined;
    } while (pageToken);
    return files;
  });
};

const parseQuotaNumber = (value: unknown): number | undefined => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

export const getDriveStorageQuota = async (
  session: GoogleAccountSession,
): Promise<DriveStorageQuota> => {
  return measureAsync('sync.drive.quota', async () => {
    const params = new URLSearchParams({
      fields: 'storageQuota(limit,usage,usageInDrive,usageInDriveTrash)',
    });
    const response = await driveRequest('list', `${DRIVE_ABOUT_ENDPOINT}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${requireDriveAccessToken(session)}` },
    });
    const quota = (await response.json())?.storageQuota || {};
    return {
      limit: parseQuotaNumber(quota.limit),
      usage: parseQuotaNumber(quota.usage),
      usageInDrive: parseQuotaNumber(quota.usageInDrive),
      usageInDriveTrash: parseQuotaNumber(quota.usageInDriveTrash),
    };
  });
};
