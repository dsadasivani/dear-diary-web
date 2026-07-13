package com.deardiary.sync.snapshot;

import java.time.Instant;
import java.util.UUID;

public record SnapshotResponse(
    UUID snapshotId,
    String status,
    long throughSequence,
    String partitionKey,
    String objectKey,
    String sha256,
    long sizeBytes,
    int keyEpoch,
    int snapshotSchemaVersion,
    String downloadUrl,
    Instant downloadExpiresAt
) {}
