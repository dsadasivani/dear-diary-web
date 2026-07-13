package com.deardiary.sync.keypackage;

import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import java.util.UUID;

public record KeyPackageRequest(
    @NotNull UUID keyPackageId,
    @NotNull UUID creatorDeviceId,
    @NotNull UUID targetDeviceId,
    @Min(1) int keyEpoch,
    @NotBlank @Pattern(regexp = "DEVICE|RECOVERY") String purpose,
    @NotBlank @Pattern(regexp = "^[0-9a-f]{64}$") String sha256,
    @Min(1) long sizeBytes,
    @Min(1) int packageSchemaVersion,
    UUID rotationId,
    UUID recoveryAttemptId
) {}
