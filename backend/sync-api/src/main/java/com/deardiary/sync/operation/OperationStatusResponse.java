package com.deardiary.sync.operation;

import java.util.UUID;

public record OperationStatusResponse(
    UUID operationId,
    String status,
    Long sequence,
    Long recordVersion,
    String lastErrorCode
) {}
