package com.deardiary.sync.notification;

import java.util.UUID;

public record SyncNotification(UUID notificationId, UUID accountId, long sequence, String type) {}
