package com.deardiary.sync.media;

import java.net.URI;
import java.time.Instant;
import java.util.UUID;

public record MediaDownloadResponse(
    UUID objectId,
    String objectKind,
    String sha256,
    long sizeBytes,
    int keyEpoch,
    URI downloadUrl,
    Instant downloadExpiresAt
) {}
