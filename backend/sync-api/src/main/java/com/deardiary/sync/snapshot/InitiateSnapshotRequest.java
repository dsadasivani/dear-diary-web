package com.deardiary.sync.snapshot;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import jakarta.validation.Valid;
import java.util.List;
import java.util.UUID;

public record InitiateSnapshotRequest(
    @NotNull UUID snapshotId,
    @NotNull UUID deviceId,
    @Min(0) long throughSequence,
    @NotBlank @Pattern(regexp = "^[a-z0-9:_-]{1,128}$") String partitionKey,
    @NotBlank @Pattern(regexp = "^[0-9a-f]{64}$") String sha256,
    @Min(1) long sizeBytes,
    @Min(1) int keyEpoch,
    @Min(1) int snapshotSchemaVersion,
    @Min(1) @Max(1_000_000) int protocolVersion,
    String metadataSignature,
    @Size(max = 512) List<@Valid Chunk> chunks
) {
    public InitiateSnapshotRequest(
            UUID snapshotId, UUID deviceId, long throughSequence, String partitionKey,
            String sha256, long sizeBytes, int keyEpoch, int snapshotSchemaVersion,
            int protocolVersion, String metadataSignature) {
        this(snapshotId, deviceId, throughSequence, partitionKey, sha256, sizeBytes,
            keyEpoch, snapshotSchemaVersion, protocolVersion, metadataSignature, List.of());
    }

    public record Chunk(
        @Min(0) int index,
        @NotBlank @Pattern(regexp = "^[0-9a-f]{64}$") String sha256,
        @Min(1) long sizeBytes
    ) {}
}
