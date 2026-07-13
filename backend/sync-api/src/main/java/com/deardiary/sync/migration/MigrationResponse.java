package com.deardiary.sync.migration;

import java.util.UUID;

public record MigrationResponse(
    UUID migrationId,
    String status,
    String baselineDigest,
    String validationDigest,
    long baselineSequence,
    Long activatedSequence,
    UUID snapshotId,
    String v1Mode
) {}
