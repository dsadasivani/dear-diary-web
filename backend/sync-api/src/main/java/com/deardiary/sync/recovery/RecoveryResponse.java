package com.deardiary.sync.recovery;

import com.deardiary.sync.keypackage.KeyPackageResponse;
import java.time.Instant;
import java.util.UUID;

public record RecoveryResponse(
    UUID recoveryAttemptId,
    UUID recoveryDeviceId,
    String status,
    UUID validationSnapshotId,
    Instant expiresAt,
    KeyPackageResponse recoveryPackage
) {}
