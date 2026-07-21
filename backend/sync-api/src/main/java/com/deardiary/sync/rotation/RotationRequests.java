package com.deardiary.sync.rotation;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import java.util.UUID;

public final class RotationRequests {
    private RotationRequests() {}
    public record Begin(@NotNull UUID rotationId, @NotNull UUID deviceId, UUID revokedDeviceId) {
        public Begin(UUID rotationId, UUID deviceId) { this(rotationId, deviceId, null); }
    }
    public record Advance(@NotNull UUID deviceId, @NotBlank String nextStatus) {}
    public record LocalCommitted(@NotNull UUID deviceId, @NotBlank String possessionSignature) {}
}
