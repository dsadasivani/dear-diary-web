package com.deardiary.sync.objectstore;

public record UploadObjectCommand(
    ObjectKey objectKey,
    String objectKind,
    String sha256,
    long sizeBytes
) {}
