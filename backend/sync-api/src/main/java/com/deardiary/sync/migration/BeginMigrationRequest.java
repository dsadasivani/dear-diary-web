package com.deardiary.sync.migration;

import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import java.util.UUID;

public record BeginMigrationRequest(
    @NotNull UUID migrationId,
    @NotNull UUID deviceId,
    @NotBlank @Pattern(regexp = "^[0-9a-f]{64}$") String baselineDigest,
    @Min(0) long baselineSequence
) {}
