package com.deardiary.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Bundle;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final String DEVICE_LOCK_EVENT = "dear-diary:device-locked";
    private final BroadcastReceiver screenLockReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (Intent.ACTION_SCREEN_OFF.equals(intent.getAction()) && bridge != null) {
                bridge.triggerWindowJSEvent(DEVICE_LOCK_EVENT);
            }
        }
    };

    @Override
    public void onCreate(Bundle savedInstanceState) {
        LegacyDriveTeardown.run(this);
        super.onCreate(savedInstanceState);
        ContextCompat.registerReceiver(
            this,
            screenLockReceiver,
            new IntentFilter(Intent.ACTION_SCREEN_OFF),
            ContextCompat.RECEIVER_NOT_EXPORTED
        );
    }

    @Override
    public void onDestroy() {
        unregisterReceiver(screenLockReceiver);
        super.onDestroy();
    }
}
