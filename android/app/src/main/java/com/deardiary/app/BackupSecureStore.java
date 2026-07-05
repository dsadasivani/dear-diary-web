package com.deardiary.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class BackupSecureStore {
    static final String ACCOUNT_USER_ID = "account_user_id";
    static final String ACCOUNT_EMAIL = "account_email";
    static final String ACCOUNT_DISPLAY_NAME = "account_display_name";
    static final String ACCOUNT_LINKED_AT = "account_linked_at";
    static final String REAUTH_REQUIRED = "reauth_required";
    static final String SCHEDULE_MODE = "schedule_mode";
    static final String SCHEDULE_TIME = "schedule_time";
    static final String SCHEDULE_DAY = "schedule_day";
    static final String SCHEDULE_NETWORK = "schedule_network";
    static final String SCHEDULE_TIMEZONE = "schedule_timezone";
    static final String STAGED_PATH = "staged_path";
    static final String STAGED_SIZE = "staged_size";
    static final String STAGED_SCHEMA = "staged_schema";
    static final String STAGED_REVISION = "staged_revision";
    static final String STAGED_ENCRYPTED = "staged_encrypted";
    static final String STAGED_ENCRYPTION_KEY_ID = "staged_encryption_key_id";
    static final String DEVICE_ID = "device_id";
    static final String PARENT_FILE_ID = "parent_file_id";
    static final String LAST_BACKUP_AT = "last_backup_at";
    static final String LAST_BACKUP_FILE_ID = "last_backup_file_id";
    static final String LAST_BACKUP_SIZE = "last_backup_size";
    static final String UPLOADED_REVISION = "uploaded_revision";
    static final String ACTIVE_DEVICE_ID = "active_device_id";
    static final String LAST_ATTEMPT_AT = "last_attempt_at";
    static final String LAST_ERROR_CODE = "last_error_code";
    static final String CLOUD_WRITE_BLOCKED = "cloud_write_blocked";
    static final String UPLOAD_URL = "upload_url";
    static final String UPLOAD_OFFSET = "upload_offset";
    static final String UPLOAD_REVISION = "upload_revision";

    private static final String PREFERENCES = "deardiary_drive_secure_v1";
    private static final String KEY_ALIAS = "deardiary_drive_state_key_v1";
    private static final String ANDROID_KEYSTORE = "AndroidKeyStore";
    private final SharedPreferences preferences;

    BackupSecureStore(Context context) {
        preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }

    synchronized void putString(String key, String value) {
        if (value == null) {
            preferences.edit().remove(key).apply();
            return;
        }
        preferences.edit().putString(key, encrypt(value)).apply();
    }

    synchronized String getString(String key, String fallback) {
        String encrypted = preferences.getString(key, null);
        if (encrypted == null) return fallback;
        try {
            return decrypt(encrypted);
        } catch (Exception error) {
            return fallback;
        }
    }

    void putLong(String key, long value) {
        putString(key, Long.toString(value));
    }

    long getLong(String key, long fallback) {
        try {
            return Long.parseLong(getString(key, Long.toString(fallback)));
        } catch (NumberFormatException error) {
            return fallback;
        }
    }

    void putBoolean(String key, boolean value) {
        putString(key, Boolean.toString(value));
    }

    boolean getBoolean(String key, boolean fallback) {
        return Boolean.parseBoolean(getString(key, Boolean.toString(fallback)));
    }

    synchronized void remove(String... keys) {
        SharedPreferences.Editor editor = preferences.edit();
        for (String key : keys) editor.remove(key);
        editor.apply();
    }

    void clearAccount() {
        remove(ACCOUNT_USER_ID, ACCOUNT_EMAIL, ACCOUNT_DISPLAY_NAME, ACCOUNT_LINKED_AT);
        clearDriveRuntime();
    }

    void clearDriveRuntime() {
        remove(
            REAUTH_REQUIRED,
            STAGED_PATH,
            STAGED_SIZE,
            STAGED_SCHEMA,
            STAGED_REVISION,
            STAGED_ENCRYPTED,
            STAGED_ENCRYPTION_KEY_ID,
            PARENT_FILE_ID,
            LAST_BACKUP_AT,
            LAST_BACKUP_FILE_ID,
            LAST_BACKUP_SIZE,
            UPLOADED_REVISION,
            ACTIVE_DEVICE_ID,
            LAST_ATTEMPT_AT,
            LAST_ERROR_CODE,
            CLOUD_WRITE_BLOCKED,
            UPLOAD_URL,
            UPLOAD_OFFSET,
            UPLOAD_REVISION
        );
    }

    void clearUploadSession() {
        remove(UPLOAD_URL, UPLOAD_OFFSET, UPLOAD_REVISION);
    }

    private SecretKey getOrCreateKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance(ANDROID_KEYSTORE);
        keyStore.load(null);
        KeyStore.Entry existing = keyStore.getEntry(KEY_ALIAS, null);
        if (existing instanceof KeyStore.SecretKeyEntry) {
            return ((KeyStore.SecretKeyEntry) existing).getSecretKey();
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE);
        generator.init(new KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        ).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return generator.generateKey();
    }

    private String encrypt(String value) {
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
            byte[] cipherText = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
            return Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + "." + Base64.encodeToString(cipherText, Base64.NO_WRAP);
        } catch (Exception error) {
            throw new IllegalStateException("Could not protect backup state.", error);
        }
    }

    private String decrypt(String value) throws Exception {
        String[] parts = value.split("\\.", 2);
        if (parts.length != 2) throw new IllegalArgumentException("Invalid protected value.");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(
            Cipher.DECRYPT_MODE,
            getOrCreateKey(),
            new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP))
        );
        return new String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8);
    }
}
