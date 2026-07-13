package com.deardiary.sync.snapshot;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

public record InitiateSnapshotResponse(
    UUID snapshotId,
    String status,
    boolean existing,
    Upload upload
) {
    public record Upload(
        String objectKey,
        String uploadUrl,
        Map<String, List<String>> headers,
        Instant expiresAt
    ) {}
}
