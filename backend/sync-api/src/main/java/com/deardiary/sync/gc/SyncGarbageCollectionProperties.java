package com.deardiary.sync.gc;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import java.time.Duration;
import org.hibernate.validator.constraints.time.DurationMin;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

@Validated
@ConfigurationProperties(prefix = "sync.garbage-collection")
public record SyncGarbageCollectionProperties(
    boolean enabled,
    boolean dryRun,
    @NotNull @DurationMin(hours = 1) Duration retention,
    @NotNull @DurationMin(hours = 1) Duration quarantineDelay,
    @Min(1) @Max(100) int maximumBatchSize,
    @Min(1) @Max(100) int maximumAttempts
) {}
