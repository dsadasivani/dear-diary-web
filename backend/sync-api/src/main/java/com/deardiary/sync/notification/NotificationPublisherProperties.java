package com.deardiary.sync.notification;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import java.net.URI;
import java.time.Duration;
import org.hibernate.validator.constraints.time.DurationMin;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

@Validated
@ConfigurationProperties(prefix = "sync.notification.publisher")
public record NotificationPublisherProperties(
    boolean enabled,
    @NotNull URI endpoint,
    @NotBlank String bearerToken,
    @NotNull @DurationMin(seconds = 1) Duration timeout
) {}
