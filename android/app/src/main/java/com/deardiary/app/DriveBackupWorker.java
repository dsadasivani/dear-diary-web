package com.deardiary.app;

import android.content.Context;
import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import com.google.android.gms.auth.api.identity.AuthorizationResult;
import java.io.File;
import java.util.List;
import java.util.Locale;

public final class DriveBackupWorker extends Worker {
    private final BackupSecureStore store;
    private String activeToken;

    public DriveBackupWorker(@NonNull Context context, @NonNull WorkerParameters parameters) {
        super(context, parameters);
        store = new BackupSecureStore(context);
    }

    @NonNull
    @Override
    public Result doWork() {
        boolean manual = getInputData().getBoolean(DriveBackupScheduler.INPUT_MANUAL, false);
        try {
            store.putLong(BackupSecureStore.LAST_ATTEMPT_AT, System.currentTimeMillis());
            if (store.getBoolean(BackupSecureStore.CLOUD_WRITE_BLOCKED, false)) {
                return finish(Result.success(), manual);
            }
            String email = store.getString(BackupSecureStore.ACCOUNT_EMAIL, "");
            String stagedPath = store.getString(BackupSecureStore.STAGED_PATH, "");
            long stagedRevision = store.getLong(BackupSecureStore.STAGED_REVISION, 0);
            long uploadedRevision = store.getLong(BackupSecureStore.UPLOADED_REVISION, 0);
            if (email.isEmpty() || stagedPath.isEmpty() || (!manual && stagedRevision <= uploadedRevision)) {
                return finish(Result.success(), manual);
            }

            File stagedFile = new File(getApplicationContext().getFilesDir(), stagedPath);
            if (!stagedFile.isFile()) {
                markError("staged_file_missing", false);
                return finish(Result.success(), manual);
            }

            AuthorizationResult authorization = DriveAuthorization.authorizeBlocking(getApplicationContext(), email);
            if (authorization.hasResolution() || authorization.getAccessToken() == null) {
                markError("reauthorization_required", false);
                store.putBoolean(BackupSecureStore.REAUTH_REQUIRED, true);
                return finish(Result.success(), manual);
            }

            activeToken = authorization.getAccessToken();
            DriveApiClient drive = new DriveApiClient(activeToken, store);
            List<DriveApiClient.BackupFile> backups = drive.listBackups();
            if (isOwnershipConflict(backups)) {
                markError("newer_backup_on_another_device", true);
                return finish(Result.success(), manual);
            }

            String deviceId = store.getString(BackupSecureStore.DEVICE_ID, "");
            String parentFileId = store.getString(BackupSecureStore.PARENT_FILE_ID, "");
            int schemaVersion = (int) store.getLong(BackupSecureStore.STAGED_SCHEMA, 2);
            boolean encrypted = store.getBoolean(BackupSecureStore.STAGED_ENCRYPTED, false);
            String encryptionKeyId = store.getString(BackupSecureStore.STAGED_ENCRYPTION_KEY_ID, "");
            DriveApiClient.BackupFile uploaded = drive.upload(
                stagedFile,
                deviceId,
                stagedRevision,
                parentFileId,
                schemaVersion,
                encrypted,
                encryptionKeyId
            );

            long now = System.currentTimeMillis();
            store.putLong(BackupSecureStore.LAST_BACKUP_AT, now);
            store.putString(BackupSecureStore.LAST_BACKUP_FILE_ID, uploaded.id);
            store.putLong(BackupSecureStore.LAST_BACKUP_SIZE, uploaded.size > 0 ? uploaded.size : stagedFile.length());
            store.putLong(BackupSecureStore.UPLOADED_REVISION, stagedRevision);
            store.putString(BackupSecureStore.PARENT_FILE_ID, uploaded.id);
            store.putString(BackupSecureStore.ACTIVE_DEVICE_ID, deviceId);
            store.putString(BackupSecureStore.LAST_ERROR_CODE, null);
            store.putBoolean(BackupSecureStore.REAUTH_REQUIRED, false);
            store.putBoolean(BackupSecureStore.CLOUD_WRITE_BLOCKED, false);
            backups = drive.listBackups();
            drive.prune(backups, 5);
            return finish(Result.success(), manual);
        } catch (DriveApiClient.DriveHttpException error) {
            if (error.status == 401) {
                DriveAuthorization.clearTokenBlocking(getApplicationContext(), activeToken);
                markError("refreshing_authorization", false);
                return Result.retry();
            }
            if (error.status == 404 || error.status == 410) {
                store.clearUploadSession();
                markError("restarting_upload", false);
                return Result.retry();
            }
            if (error.status == 403) {
                String detail = (error.reason + " " + error.getMessage()).toLowerCase(Locale.ROOT);
                if (detail.contains("service_disabled") || detail.contains("accessnotconfigured") || detail.contains("has not been used") || detail.contains("is disabled")) {
                    markError("drive_api_disabled", false);
                    return finish(Result.failure(), manual);
                }
                if (detail.contains("storagequotaexceeded") || detail.contains("quota exceeded")) {
                    markError("drive_quota_exceeded", false);
                    return finish(Result.failure(), manual);
                }
                if (detail.contains("ratelimit") || detail.contains("userratelimit")) {
                    markError("temporary_drive_error", false);
                    return Result.retry();
                }
                markError("reauthorization_required", false);
                store.putBoolean(BackupSecureStore.REAUTH_REQUIRED, true);
                return finish(Result.success(), manual);
            }
            if (error.status == 429 || error.status >= 500) {
                markError("temporary_drive_error", false);
                return Result.retry();
            }
            markError("drive_request_failed", false);
            return finish(Result.failure(), manual);
        } catch (Exception error) {
            markError("backup_failed", false);
            return getRunAttemptCount() < 4 ? Result.retry() : finish(Result.failure(), manual);
        }
    }

    private boolean isOwnershipConflict(List<DriveApiClient.BackupFile> backups) {
        if (backups.isEmpty()) return false;
        DriveApiClient.BackupFile latest = backups.get(0);
        String parentFileId = store.getString(BackupSecureStore.PARENT_FILE_ID, "");
        String deviceId = store.getString(BackupSecureStore.DEVICE_ID, "");
        if (latest.id.equals(parentFileId) || deviceId.equals(latest.deviceId)) return false;
        return !latest.id.isEmpty();
    }

    private void markError(String code, boolean blocked) {
        store.putString(BackupSecureStore.LAST_ERROR_CODE, code);
        store.putBoolean(BackupSecureStore.CLOUD_WRITE_BLOCKED, blocked);
    }

    private Result finish(Result result, boolean manual) {
        if (!manual) DriveBackupScheduler.configure(getApplicationContext());
        return result;
    }
}
