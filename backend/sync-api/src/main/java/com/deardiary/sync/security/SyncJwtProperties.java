package com.deardiary.sync.security;

import jakarta.validation.constraints.NotBlank;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

@Validated
@ConfigurationProperties(prefix = "sync.security.jwt")
public record SyncJwtProperties(
    boolean enabled,
    @NotBlank String issuerUri,
    String jwkSetUri,
    String audience
) {
    public String resolvedJwkSetUri() {
        if (jwkSetUri != null && !jwkSetUri.isBlank()) return jwkSetUri;
        return issuerUri.replaceAll("/+$", "") + "/.well-known/jwks.json";
    }
}
