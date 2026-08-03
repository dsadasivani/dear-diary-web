package com.deardiary.app;

import android.content.Context;
import androidx.work.WorkManager;
import java.security.KeyStore;

/** One-time cleanup for builds that previously scheduled Google Drive backups. */
final class LegacyDriveTeardown {
    private static final String MIGRATION_PREFERENCES = "deardiary_migrations";
    private static final String COMPLETED_KEY = "drive_v1_teardown_complete";
    private static final String DRIVE_PREFERENCES = "deardiary_drive_secure_v1";
    private static final String DRIVE_KEY_ALIAS = "deardiary_drive_state_key_v1";

    private LegacyDriveTeardown() {}

    static void run(Context context) {
        var migrations = context.getSharedPreferences(MIGRATION_PREFERENCES, Context.MODE_PRIVATE);
        if (migrations.getBoolean(COMPLETED_KEY, false)) return;

        var workManager = WorkManager.getInstance(context);
        workManager.cancelUniqueWork("deardiary-drive-backup-scheduled");
        workManager.cancelUniqueWork("deardiary-drive-backup-manual");
        context.getSharedPreferences(DRIVE_PREFERENCES, Context.MODE_PRIVATE).edit().clear().apply();
        try {
            var keyStore = KeyStore.getInstance("AndroidKeyStore");
            keyStore.load(null);
            if (keyStore.containsAlias(DRIVE_KEY_ALIAS)) keyStore.deleteEntry(DRIVE_KEY_ALIAS);
        } catch (Exception ignored) {
            // Preference deletion still prevents the obsolete credential from being used.
        }
        migrations.edit().putBoolean(COMPLETED_KEY, true).apply();
    }
}
