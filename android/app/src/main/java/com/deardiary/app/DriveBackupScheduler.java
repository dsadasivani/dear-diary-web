package com.deardiary.app;

import android.content.Context;
import androidx.work.BackoffPolicy;
import androidx.work.Constraints;
import androidx.work.Data;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;
import java.time.DayOfWeek;
import java.time.Duration;
import java.time.LocalTime;
import java.time.ZonedDateTime;
import java.time.format.DateTimeParseException;
import java.util.concurrent.TimeUnit;

final class DriveBackupScheduler {
    static final String SCHEDULED_WORK = "deardiary-drive-backup-scheduled";
    static final String MANUAL_WORK = "deardiary-drive-backup-manual";
    static final String INPUT_MANUAL = "manual";

    private DriveBackupScheduler() {}

    static void configure(Context context) {
        BackupSecureStore store = new BackupSecureStore(context);
        String mode = store.getString(BackupSecureStore.SCHEDULE_MODE, "daily");
        WorkManager manager = WorkManager.getInstance(context);
        if ("off".equals(mode) || store.getString(BackupSecureStore.ACCOUNT_EMAIL, "").isEmpty()) {
            manager.cancelUniqueWork(SCHEDULED_WORK);
            return;
        }

        Constraints constraints = new Constraints.Builder()
            .setRequiredNetworkType("wifi".equals(store.getString(BackupSecureStore.SCHEDULE_NETWORK, "wifi"))
                ? NetworkType.UNMETERED
                : NetworkType.CONNECTED)
            .setRequiresBatteryNotLow(true)
            .setRequiresStorageNotLow(true)
            .build();

        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(DriveBackupWorker.class)
            .setConstraints(constraints)
            .setInitialDelay(delayUntilNextRun(store), TimeUnit.MILLISECONDS)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build();
        manager.enqueueUniqueWork(SCHEDULED_WORK, ExistingWorkPolicy.REPLACE, request);
    }

    static void runNow(Context context) {
        Constraints constraints = new Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .setRequiresBatteryNotLow(true)
            .setRequiresStorageNotLow(true)
            .build();
        Data data = new Data.Builder().putBoolean(INPUT_MANUAL, true).build();
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(DriveBackupWorker.class)
            .setInputData(data)
            .setConstraints(constraints)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build();
        WorkManager.getInstance(context).enqueueUniqueWork(MANUAL_WORK, ExistingWorkPolicy.REPLACE, request);
    }

    static void cancelAll(Context context) {
        WorkManager manager = WorkManager.getInstance(context);
        manager.cancelUniqueWork(SCHEDULED_WORK);
        manager.cancelUniqueWork(MANUAL_WORK);
    }

    private static long delayUntilNextRun(BackupSecureStore store) {
        LocalTime time;
        try {
            time = LocalTime.parse(store.getString(BackupSecureStore.SCHEDULE_TIME, "02:00"));
        } catch (DateTimeParseException error) {
            time = LocalTime.of(2, 0);
        }

        ZonedDateTime now = ZonedDateTime.now();
        ZonedDateTime next = now.withHour(time.getHour()).withMinute(time.getMinute()).withSecond(0).withNano(0);
        String mode = store.getString(BackupSecureStore.SCHEDULE_MODE, "daily");
        if ("weekly".equals(mode)) {
            int jsDay = (int) store.getLong(BackupSecureStore.SCHEDULE_DAY, 0);
            DayOfWeek target = DayOfWeek.of(jsDay == 0 ? 7 : Math.max(1, Math.min(jsDay, 6)));
            while (next.getDayOfWeek() != target || !next.isAfter(now)) next = next.plusDays(1);
        } else if (!next.isAfter(now)) {
            next = next.plusDays(1);
        }
        return Math.max(1_000, Duration.between(now, next).toMillis());
    }
}
