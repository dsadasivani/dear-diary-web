package com.deardiary.sync.recovery;

import com.deardiary.sync.keypackage.KeyPackageResponse;
import java.util.UUID;

public record RecoveryResponse(
    UUID recoveryAttemptId,
    UUID recoveryDeviceId,
    String status,
    UUID validationSnapshotId,
    KeyPackageResponse recoveryPackage
) {}
