package com.deardiary.sync.objectstore;

import java.util.Map;

public record ObjectMetadata(ObjectKey objectKey, long sizeBytes, String sha256, Map<String, String> metadata) {}
