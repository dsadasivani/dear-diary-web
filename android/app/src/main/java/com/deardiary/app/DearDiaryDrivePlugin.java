package com.deardiary.app;

import android.app.Activity;
import android.app.PendingIntent;
import android.accounts.Account;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import androidx.activity.result.ActivityResult;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.auth.GoogleAuthUtil;
import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.auth.api.identity.AuthorizationResult;
import com.google.android.gms.auth.api.identity.Identity;
import com.google.android.gms.auth.api.identity.RevokeAccessRequest;
import com.google.android.gms.auth.api.signin.GoogleSignInAccount;

@CapacitorPlugin(name = "DearDiaryDrive")
public class DearDiaryDrivePlugin extends Plugin {
    private BackupSecureStore store;
    private ActivityResultLauncher<IntentSenderRequest> authorizationLauncher;
    private PluginCall pendingAuthorizationCall;

    @Override
    public void load() {
        store = new BackupSecureStore(getContext());
        authorizationLauncher = getActivity().registerForActivityResult(
            new ActivityResultContracts.StartIntentSenderForResult(),
            this::handleAuthorizationResult
        );
    }

    @PluginMethod
    public void saveLinkedAccount(PluginCall call) {
        String userId = call.getString("userId");
        String email = call.getString("email");
        if (userId == null || email == null || email.isBlank()) {
            call.reject("A Google user ID and email are required.");
            return;
        }
        String previousUserId = store.getString(BackupSecureStore.ACCOUNT_USER_ID, "");
        if (!previousUserId.isEmpty() && !previousUserId.equals(userId)) {
            DriveBackupScheduler.cancelAll(getContext());
            store.clearDriveRuntime();
        }
        store.putString(BackupSecureStore.ACCOUNT_USER_ID, userId);
        store.putString(BackupSecureStore.ACCOUNT_EMAIL, email);
        store.putString(BackupSecureStore.ACCOUNT_DISPLAY_NAME, call.getString("displayName"));
        store.putLong(BackupSecureStore.ACCOUNT_LINKED_AT, call.getLong("linkedAt", System.currentTimeMillis()));
        store.putBoolean(BackupSecureStore.REAUTH_REQUIRED, false);
        DriveBackupScheduler.configure(getContext());
        call.resolve();
    }

    @PluginMethod
    public void getConnectionState(PluginCall call) {
        call.resolve(connectionState(false, null));
    }

    @PluginMethod
    public void authorize(PluginCall call) {
        String email = store.getString(BackupSecureStore.ACCOUNT_EMAIL, "");
        if (email.isEmpty()) {
            call.resolve(connectionState(false, null));
            return;
        }
        boolean interactive = call.getBoolean("interactive", false);
        AuthorizationRequest request = DriveAuthorization.requestFor(email);
        Identity.getAuthorizationClient(getActivity()).authorize(request)
            .addOnSuccessListener(result -> {
                if (!result.hasResolution()) {
                    resolveAuthorized(call, result);
                    return;
                }
                if (!interactive) {
                    store.putBoolean(BackupSecureStore.REAUTH_REQUIRED, true);
                    call.resolve(connectionState(false, null));
                    return;
                }
                PendingIntent intent = result.getPendingIntent();
                if (intent == null) {
                    call.reject("Google authorization did not provide a consent action.");
                    return;
                }
                pendingAuthorizationCall = call;
                authorizationLauncher.launch(new IntentSenderRequest.Builder(intent).build());
            })
            .addOnFailureListener(error -> call.reject(error.getMessage() == null ? "Google authorization failed." : error.getMessage()));
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        String email = store.getString(BackupSecureStore.ACCOUNT_EMAIL, "");
        DriveBackupScheduler.cancelAll(getContext());
        store.clearAccount();
        if (email.isEmpty()) {
            call.resolve();
            return;
        }
        RevokeAccessRequest request = RevokeAccessRequest.builder()
            .setAccount(new Account(email, GoogleAuthUtil.GOOGLE_ACCOUNT_TYPE))
            .build();
        Identity.getAuthorizationClient(getContext()).revokeAccess(request)
            .addOnCompleteListener(task -> call.resolve());
    }

    @PluginMethod
    public void configureSchedule(PluginCall call) {
        store.putString(BackupSecureStore.SCHEDULE_MODE, call.getString("mode", "daily"));
        store.putString(BackupSecureStore.SCHEDULE_TIME, call.getString("localTime", "02:00"));
        store.putLong(BackupSecureStore.SCHEDULE_DAY, call.getInt("weeklyDay", 0));
        store.putString(BackupSecureStore.SCHEDULE_NETWORK, call.getString("network", "wifi"));
        store.putString(BackupSecureStore.SCHEDULE_TIMEZONE, call.getString("timezone", "UTC"));
        DriveBackupScheduler.configure(getContext());
        call.resolve();
    }

    @PluginMethod
    public void stageBackup(PluginCall call) {
        String path = call.getString("path");
        String deviceId = call.getString("deviceId");
        if (path == null || deviceId == null) {
            call.reject("A staged backup path and device ID are required.");
            return;
        }
        long revision = call.getLong("contentRevision", 0L);
        if (store.getLong(BackupSecureStore.UPLOAD_REVISION, -1) != revision) store.clearUploadSession();
        store.putString(BackupSecureStore.STAGED_PATH, path);
        store.putLong(BackupSecureStore.STAGED_SIZE, call.getLong("sizeBytes", 0L));
        store.putLong(BackupSecureStore.STAGED_SCHEMA, call.getInt("schemaVersion", 2));
        store.putLong(BackupSecureStore.STAGED_REVISION, revision);
        store.putBoolean(BackupSecureStore.STAGED_ENCRYPTED, call.getBoolean("encrypted", false));
        store.putString(BackupSecureStore.STAGED_ENCRYPTION_KEY_ID, call.getString("encryptionKeyId"));
        store.putString(BackupSecureStore.DEVICE_ID, deviceId);
        store.putString(BackupSecureStore.PARENT_FILE_ID, call.getString("parentBackupFileId"));
        store.putBoolean(BackupSecureStore.CLOUD_WRITE_BLOCKED, false);
        store.putString(BackupSecureStore.LAST_ERROR_CODE, null);
        call.resolve();
    }

    @PluginMethod
    public void runBackupNow(PluginCall call) {
        DriveBackupScheduler.runNow(getContext());
        call.resolve();
    }

    @PluginMethod
    public void getRuntimeState(PluginCall call) {
        JSObject result = new JSObject();
        putLongIfPresent(result, "lastBackupAt", BackupSecureStore.LAST_BACKUP_AT);
        putLongIfPresent(result, "lastBackupSizeBytes", BackupSecureStore.LAST_BACKUP_SIZE);
        putLongIfPresent(result, "lastAttemptAt", BackupSecureStore.LAST_ATTEMPT_AT);
        putLongIfPresent(result, "stagedContentRevision", BackupSecureStore.STAGED_REVISION);
        putLongIfPresent(result, "uploadedContentRevision", BackupSecureStore.UPLOADED_REVISION);
        putStringIfPresent(result, "lastBackupFileId", BackupSecureStore.LAST_BACKUP_FILE_ID);
        putStringIfPresent(result, "parentBackupFileId", BackupSecureStore.PARENT_FILE_ID);
        putStringIfPresent(result, "activeDeviceId", BackupSecureStore.ACTIVE_DEVICE_ID);
        putStringIfPresent(result, "lastErrorCode", BackupSecureStore.LAST_ERROR_CODE);
        putStringIfPresent(result, "deviceId", BackupSecureStore.DEVICE_ID);
        result.put("cloudWriteBlocked", store.getBoolean(BackupSecureStore.CLOUD_WRITE_BLOCKED, false));
        call.resolve(result);
    }

    @PluginMethod
    public void getNetworkState(PluginCall call) {
        ConnectivityManager manager = (ConnectivityManager) getContext().getSystemService(android.content.Context.CONNECTIVITY_SERVICE);
        Network network = manager.getActiveNetwork();
        NetworkCapabilities capabilities = network == null ? null : manager.getNetworkCapabilities(network);
        JSObject result = new JSObject();
        result.put("connected", capabilities != null && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET));
        result.put("metered", manager.isActiveNetworkMetered());
        call.resolve(result);
    }

    @PluginMethod
    public void setCloudWriteBlocked(PluginCall call) {
        store.putBoolean(BackupSecureStore.CLOUD_WRITE_BLOCKED, call.getBoolean("blocked", false));
        call.resolve();
    }

    private void handleAuthorizationResult(ActivityResult activityResult) {
        PluginCall call = pendingAuthorizationCall;
        pendingAuthorizationCall = null;
        if (call == null) return;
        if (activityResult.getResultCode() != Activity.RESULT_OK || activityResult.getData() == null) {
            store.putBoolean(BackupSecureStore.REAUTH_REQUIRED, true);
            call.reject("Google authorization was cancelled.", "AUTHORIZATION_CANCELLED");
            return;
        }
        try {
            AuthorizationResult result = Identity.getAuthorizationClient(getActivity())
                .getAuthorizationResultFromIntent(activityResult.getData());
            resolveAuthorized(call, result);
        } catch (Exception error) {
            call.reject(error.getMessage() == null ? "Google authorization failed." : error.getMessage());
        }
    }

    private void resolveAuthorized(PluginCall call, AuthorizationResult result) {
        String token = result.getAccessToken();
        if (token == null || token.isEmpty()) {
            store.putBoolean(BackupSecureStore.REAUTH_REQUIRED, true);
            call.resolve(connectionState(false, null));
            return;
        }
        GoogleSignInAccount googleAccount = result.toGoogleSignInAccount();
        String expectedEmail = store.getString(BackupSecureStore.ACCOUNT_EMAIL, "");
        if (googleAccount != null && googleAccount.getEmail() != null && !expectedEmail.equalsIgnoreCase(googleAccount.getEmail())) {
            call.reject("Google authorized a different account.", "ACCOUNT_MISMATCH");
            return;
        }
        store.putBoolean(BackupSecureStore.REAUTH_REQUIRED, false);
        call.resolve(connectionState(true, token));
    }

    private JSObject connectionState(boolean authorized, String token) {
        String userId = store.getString(BackupSecureStore.ACCOUNT_USER_ID, "");
        String email = store.getString(BackupSecureStore.ACCOUNT_EMAIL, "");
        boolean linked = !userId.isEmpty() && !email.isEmpty();
        JSObject result = new JSObject();
        result.put("linked", linked);
        result.put("authorized", authorized);
        result.put("reauthorizationRequired", linked && store.getBoolean(BackupSecureStore.REAUTH_REQUIRED, false));
        result.put("accessToken", token == null ? JSONObjectNull.INSTANCE : token);
        if (linked) {
            JSObject account = new JSObject();
            account.put("userId", userId);
            account.put("email", email);
            String displayName = store.getString(BackupSecureStore.ACCOUNT_DISPLAY_NAME, "");
            account.put("displayName", displayName.isEmpty() ? JSONObjectNull.INSTANCE : displayName);
            account.put("linkedAt", store.getLong(BackupSecureStore.ACCOUNT_LINKED_AT, System.currentTimeMillis()));
            result.put("account", account);
        } else {
            result.put("account", JSONObjectNull.INSTANCE);
        }
        return result;
    }

    private void putLongIfPresent(JSObject result, String outputKey, String storageKey) {
        long value = store.getLong(storageKey, 0);
        if (value > 0) result.put(outputKey, value);
    }

    private void putStringIfPresent(JSObject result, String outputKey, String storageKey) {
        String value = store.getString(storageKey, "");
        if (!value.isEmpty()) result.put(outputKey, value);
    }

    private static final class JSONObjectNull {
        static final Object INSTANCE = org.json.JSONObject.NULL;
    }
}
