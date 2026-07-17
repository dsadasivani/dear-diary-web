package com.deardiary.sync.pairing;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

public record PairingResponse(
    UUID accountId,
    UUID pairingId,
    UUID requestedDeviceId,
    String requestedDeviceEncryptionPublicKey,
    String platform,
    String challenge,
    String status,
    int keyEpoch,
    UUID keyPackageId,
    String objectKey,
    String sha256,
    Long sizeBytes,
    String downloadUrl,
    Instant downloadExpiresAt,
    Upload upload,
    Instant requestedAt,
    Instant expiresAt
) {
    public record Upload(String objectKey, String uploadUrl, Map<String, List<String>> headers, Instant expiresAt) {}
}
