package com.deardiary.app;

import android.content.Context;
import androidx.work.BackoffPolicy;
import androidx.work.Constraints;
import androidx.work.Data;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;
import java.util.Calendar;
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
        int[] time = parseHourMinute(store.getString(BackupSecureStore.SCHEDULE_TIME, "02:00"));

        Calendar now = Calendar.getInstance();
        Calendar next = (Calendar) now.clone();
        next.set(Calendar.HOUR_OF_DAY, time[0]);
        next.set(Calendar.MINUTE, time[1]);
        next.set(Calendar.SECOND, 0);
        next.set(Calendar.MILLISECOND, 0);
        String mode = store.getString(BackupSecureStore.SCHEDULE_MODE, "daily");
        if ("weekly".equals(mode)) {
            int jsDay = (int) store.getLong(BackupSecureStore.SCHEDULE_DAY, 0);
            int target = jsDay <= 0 ? Calendar.SUNDAY : Math.min(Calendar.SATURDAY, jsDay + 1);
            while (next.get(Calendar.DAY_OF_WEEK) != target || !next.after(now)) next.add(Calendar.DATE, 1);
        } else if (!next.after(now)) {
            next.add(Calendar.DATE, 1);
        }
        return Math.max(1_000, next.getTimeInMillis() - now.getTimeInMillis());
    }

    private static int[] parseHourMinute(String value) {
        try {
            String[] parts = value == null ? new String[0] : value.split(":", 2);
            int hour = Integer.parseInt(parts[0]);
            int minute = Integer.parseInt(parts[1]);
            if (hour < 0 || hour > 23 || minute < 0 || minute > 59) throw new IllegalArgumentException();
            return new int[] { hour, minute };
        } catch (Exception error) {
            return new int[] { 2, 0 };
        }
    }
}
