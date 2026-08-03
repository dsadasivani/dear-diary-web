package com.deardiary.sync.device;

import java.util.UUID;

public record SelfRevocationResponse(UUID deviceId, String deviceStatus) {}
