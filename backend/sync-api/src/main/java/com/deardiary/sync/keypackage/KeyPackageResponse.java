package com.deardiary.sync.keypackage;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

public record KeyPackageResponse(
    UUID keyPackageId, UUID targetDeviceId, int keyEpoch, String purpose, String status,
    String objectKey, String sha256, long sizeBytes, String downloadUrl, Instant downloadExpiresAt,
    Upload upload
) {
    public record Upload(String objectKey, String uploadUrl, Map<String, List<String>> headers, Instant expiresAt) {}
}
