package com.deardiary.sync.bootstrap;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

public record BootstrapManifestResponse(
    UUID bootstrapId,
    UUID deviceId,
    UUID pairingId,
    String status,
    Snapshot snapshot,
    long headSequence,
    long minimumAvailableSequence,
    List<Integer> requiredKeyEpochs,
    int tailCount,
    Instant expiresAt,
    Instant completedAt
) {
    public record Snapshot(
        UUID snapshotId,
        String status,
        long throughSequence,
        String partitionKey,
        String objectKey,
        String sha256,
        long sizeBytes,
        int keyEpoch,
        int snapshotSchemaVersion,
        String metadataSignature,
        String downloadUrl,
        Instant downloadExpiresAt,
        List<Chunk> chunks
    ) {
        public record Chunk(
            int index,
            String objectKey,
            String sha256,
            long sizeBytes,
            int keyEpoch,
            String downloadUrl,
            Instant downloadExpiresAt
        ) {}
    }
}
