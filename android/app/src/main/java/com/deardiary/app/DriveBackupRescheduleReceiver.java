package com.deardiary.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public final class DriveBackupRescheduleReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        DriveBackupScheduler.configure(context.getApplicationContext());
    }
}
