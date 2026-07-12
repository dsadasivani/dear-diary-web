package com.deardiary.sync.objectstore;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import java.time.Duration;
import org.hibernate.validator.constraints.time.DurationMin;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

@Validated
@ConfigurationProperties(prefix = "sync.object-store")
public record ObjectStoreProperties(
    boolean enabled,
    @NotBlank String bucket,
    @NotBlank String region,
    String endpoint,
    boolean pathStyleAccess,
    @NotNull @DurationMin(seconds = 1) Duration signedUrlTtl,
    @NotNull @DurationMin(seconds = 1) Duration apiCallTimeout,
    @NotNull @DurationMin(seconds = 1) Duration apiCallAttemptTimeout
) {}
