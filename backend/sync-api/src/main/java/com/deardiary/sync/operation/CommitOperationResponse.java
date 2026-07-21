package com.deardiary.sync.operation;

import java.util.UUID;

public record CommitOperationResponse(
    String status,
    UUID operationId,
    long sequence,
    long recordVersion
) {}
