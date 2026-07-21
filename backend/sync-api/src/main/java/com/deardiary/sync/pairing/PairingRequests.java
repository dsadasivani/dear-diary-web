package com.deardiary.sync.pairing;

import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import java.util.UUID;

public final class PairingRequests {
    private PairingRequests() {}

    public record Create(
        @NotNull UUID pairingId,
        @NotNull UUID requestedDeviceId,
        @NotBlank String requestedDeviceSigningPublicKey,
        @NotBlank String requestedDeviceEncryptionPublicKey,
        @NotBlank String platform,
        @NotBlank @Pattern(regexp = "^[0-9a-f]{64}$") String codeHash,
        @NotBlank String challenge
    ) {}

    public record Approve(
        @NotNull UUID approverDeviceId,
        @NotBlank @Pattern(regexp = "^[0-9]{8}$") String pairingCode,
        @NotBlank String approvalSignature,
        @NotNull UUID keyPackageId,
        @NotBlank @Pattern(regexp = "^[0-9a-f]{64}$") String sha256,
        @Min(1) long sizeBytes,
        @Min(1) int packageSchemaVersion
    ) {}

    public record Complete(
        @NotNull UUID requestedDeviceId,
        @NotBlank String possessionSignature
    ) {}
}
