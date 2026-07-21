package com.deardiary.sync.device;

import java.util.UUID;

public record DeviceRegistrationResponse(
    UUID accountId,
    UUID deviceId,
    String deviceRole,
    String deviceStatus,
    boolean created
) {}
