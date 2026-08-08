package com.deardiary.sync.quota;

public record QuotaResponse(
    String planId,
    String planName,
    Limits limits,
    Usage usage
) {
    public record Limits(
        int maximumCompanions,
        int maximumPhotosPerEntry,
        int maximumRecordingsPerEntry,
        long maximumStorageBytes
    ) {}

    public record Usage(long companionSlotsUsed, long storageBytesUsed) {}
}
