package com.deardiary.sync.migration;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import java.util.UUID;

public record AdvanceMigrationRequest(
    @NotNull UUID deviceId,
    @NotBlank String nextStatus,
    @Pattern(regexp = "^[0-9a-f]{64}$") String validationDigest,
    UUID snapshotId
) {}
