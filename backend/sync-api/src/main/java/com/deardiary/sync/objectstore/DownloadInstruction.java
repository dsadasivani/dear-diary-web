package com.deardiary.sync.objectstore;

import java.net.URI;
import java.time.Instant;

public record DownloadInstruction(URI url, Instant expiresAt) {}
