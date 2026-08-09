package com.deardiary.sync.quota;

public record QuotaPlan(
    String planId,
    String displayName,
    int maximumCompanions,
    int maximumPhotosPerEntry,
    int maximumRecordingsPerEntry,
    long maximumStorageBytes
) {}
