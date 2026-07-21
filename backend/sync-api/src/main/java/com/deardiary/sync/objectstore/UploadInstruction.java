package com.deardiary.sync.objectstore;

import java.net.URI;
import java.time.Instant;
import java.util.List;
import java.util.Map;

public record UploadInstruction(URI url, Map<String, List<String>> headers, Instant expiresAt) {}
