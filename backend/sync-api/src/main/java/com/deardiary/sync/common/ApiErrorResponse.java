package com.deardiary.sync.common;

import java.util.Map;

public record ApiErrorResponse(
    String code,
    String message,
    boolean retryable,
    boolean userActionRequired,
    String correlationId,
    Map<String, Object> details
) {}
