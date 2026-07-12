package com.deardiary.sync.event;

import java.net.URI;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

public record PullEventsResponse(List<Event> events, long currentSequence, boolean hasMore) {
    public record Event(
        long sequence,
        UUID eventId,
        UUID operationId,
        UUID deviceId,
        String recordType,
        UUID recordId,
        String operationType,
        long recordVersion,
        int keyEpoch,
        String partitionKey,
        String objectKey,
        String sha256,
        long sizeBytes,
        int eventSchemaVersion,
        URI downloadUrl,
        Instant downloadExpiresAt
    ) {}
}
