package com.deardiary.sync.notification;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import java.time.Duration;
import org.hibernate.validator.constraints.time.DurationMin;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

@Validated
@ConfigurationProperties(prefix = "sync.notification.worker")
public record NotificationWorkerProperties(
    boolean enabled,
    @NotNull @DurationMin(seconds = 5) Duration leaseDuration,
    @NotNull @DurationMin(seconds = 1) Duration retryBaseDelay,
    @Min(1) @Max(100) int maximumAttempts,
    @Min(1) @Max(1000) int maximumBatchSize
) {}
