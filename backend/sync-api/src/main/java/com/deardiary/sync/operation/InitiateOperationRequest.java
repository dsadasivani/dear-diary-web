package com.deardiary.sync.operation;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.util.List;
import java.util.UUID;

public record InitiateOperationRequest(
    @NotNull UUID operationId,
    @NotNull UUID deviceId,
    @NotBlank @Pattern(regexp = "DIARY|ENTRY|NOTE|SETTINGS|PROFILE") String recordType,
    @NotBlank @Size(max = 128) @Pattern(regexp = "^[A-Za-z0-9:_-]+$") String recordId,
    @NotBlank @Pattern(regexp = "UPSERT|DELETE") String operationType,
    @Min(0) long baseRecordVersion,
    @Min(1) @Max(1000) int protocolVersion,
    @Min(1) @Max(1000) int eventSchemaVersion,
    @Min(1) int keyEpoch,
    @NotBlank @Size(max = 128) String partitionKey,
    @NotEmpty @Size(max = 128) List<@Valid OperationObjectRequest> objects
) {}
