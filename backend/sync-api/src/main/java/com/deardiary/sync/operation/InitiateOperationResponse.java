package com.deardiary.sync.operation;

import java.net.URI;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

public record InitiateOperationResponse(
    UUID operationId,
    String status,
    boolean existing,
    List<Upload> uploads
) {
    public record Upload(
        String objectKey,
        URI uploadUrl,
        Map<String, List<String>> headers,
        Instant expiresAt
    ) {}
}
