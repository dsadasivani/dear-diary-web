package com.deardiary.sync.cursor;

import jakarta.validation.constraints.Min;

public record CursorAcknowledgmentRequest(@Min(0) long lastAppliedSequence) {}
