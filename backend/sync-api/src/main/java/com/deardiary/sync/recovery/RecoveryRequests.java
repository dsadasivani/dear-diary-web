package com.deardiary.sync.recovery;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import java.util.UUID;

public final class RecoveryRequests {
    private RecoveryRequests() {}
    public record Begin(
        @NotNull UUID recoveryAttemptId,
        @NotNull UUID recoveryDeviceId,
        @NotBlank String recoveryDevicePublicKey,
        @NotBlank String platform
    ) {}
    public record Persisted(
        @NotNull UUID recoveryDeviceId,
        @NotNull UUID validationSnapshotId,
        @NotBlank String possessionSignature
    ) {}
}
