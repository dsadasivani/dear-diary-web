package com.deardiary.sync.bootstrap;

import java.time.Instant;
import java.util.UUID;

public record BootstrapReadinessResponse(
    String status,
    long headSequence,
    long minimumAvailableSequence,
    UUID snapshotId,
    Long snapshotSequence,
    Instant snapshotCreatedAt,
    long snapshotLag,
    boolean snapshotRequired,
    int softTailEvents,
    int hardTailEvents
) {}
