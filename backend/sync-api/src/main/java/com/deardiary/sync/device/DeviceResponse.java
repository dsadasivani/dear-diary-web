package com.deardiary.sync.device;

import java.time.Instant;
import java.util.UUID;

public record DeviceResponse(
    UUID deviceId,
    String deviceRole,
    String deviceStatus,
    String platform,
    String encryptionPublicKey,
    Instant registeredAt,
    Instant lastSeenAt,
    String lastAppVersion
) {}
