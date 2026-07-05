package com.deardiary.app;

import android.accounts.Account;
import android.content.Context;
import com.google.android.gms.auth.GoogleAuthUtil;
import com.google.android.gms.auth.api.identity.AuthorizationClient;
import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.auth.api.identity.AuthorizationResult;
import com.google.android.gms.auth.api.identity.ClearTokenRequest;
import com.google.android.gms.auth.api.identity.Identity;
import com.google.android.gms.common.api.Scope;
import com.google.android.gms.tasks.Tasks;
import java.util.Collections;
import java.util.concurrent.TimeUnit;

final class DriveAuthorization {
    static final String DRIVE_APPDATA_SCOPE = "https://www.googleapis.com/auth/drive.appdata";

    private DriveAuthorization() {}

    static AuthorizationRequest requestFor(String email) {
        return AuthorizationRequest.builder()
            .setAccount(new Account(email, GoogleAuthUtil.GOOGLE_ACCOUNT_TYPE))
            .setRequestedScopes(Collections.singletonList(new Scope(DRIVE_APPDATA_SCOPE)))
            .build();
    }

    static AuthorizationResult authorizeBlocking(Context context, String email) throws Exception {
        return Tasks.await(
            Identity.getAuthorizationClient(context).authorize(requestFor(email)),
            45,
            TimeUnit.SECONDS
        );
    }

    static void clearTokenBlocking(Context context, String token) {
        if (token == null || token.isEmpty()) return;
        try {
            AuthorizationClient client = Identity.getAuthorizationClient(context);
            Tasks.await(client.clearToken(ClearTokenRequest.builder().setToken(token).build()), 20, TimeUnit.SECONDS);
        } catch (Exception ignored) {
        }
    }
}
