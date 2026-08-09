package com.deardiary.sync.bootstrap;

import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import java.util.UUID;

public final class BootstrapRequests {
    private BootstrapRequests() {}

    public record Create(
        @NotNull UUID bootstrapId,
        @NotNull UUID deviceId,
        UUID pairingId
    ) {}

    public record Complete(
        @NotNull UUID deviceId,
        @Min(0) long appliedThroughSequence,
        @NotBlank String possessionSignature
    ) {}
}
