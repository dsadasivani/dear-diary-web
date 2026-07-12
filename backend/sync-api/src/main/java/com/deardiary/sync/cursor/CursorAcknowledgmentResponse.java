package com.deardiary.sync.cursor;

import java.util.UUID;

public record CursorAcknowledgmentResponse(UUID deviceId, long lastAppliedSequence) {}
