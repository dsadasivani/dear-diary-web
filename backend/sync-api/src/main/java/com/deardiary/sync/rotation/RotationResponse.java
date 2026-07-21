package com.deardiary.sync.rotation;

import java.util.UUID;

public record RotationResponse(
    UUID rotationId, UUID initiatedByDeviceId, UUID revokedDeviceId,
    int fromKeyEpoch, int toKeyEpoch, String status
) {}
