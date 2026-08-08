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
    @NotEmpty @Size(max = 128) List<@Valid OperationObjectRequest> objects,
    @Size(max = 128) List<@Valid RetainedMediaObjectRequest> retainedMediaObjects,
    @Valid EntryMediaCounts entryMediaCounts
) {
    public record EntryMediaCounts(
        @Min(0) int photoCount,
        @Min(0) int recordingCount
    ) {}

    public InitiateOperationRequest(
            UUID operationId,
            UUID deviceId,
            String recordType,
            String recordId,
            String operationType,
            long baseRecordVersion,
            int protocolVersion,
            int eventSchemaVersion,
            int keyEpoch,
            String partitionKey,
            List<OperationObjectRequest> objects) {
        this(operationId, deviceId, recordType, recordId, operationType, baseRecordVersion,
            protocolVersion, eventSchemaVersion, keyEpoch, partitionKey, objects, List.of(),
            defaultEntryMediaCounts(recordType, operationType));
    }

    public InitiateOperationRequest(
            UUID operationId,
            UUID deviceId,
            String recordType,
            String recordId,
            String operationType,
            long baseRecordVersion,
            int protocolVersion,
            int eventSchemaVersion,
            int keyEpoch,
            String partitionKey,
            List<OperationObjectRequest> objects,
            List<RetainedMediaObjectRequest> retainedMediaObjects) {
        this(operationId, deviceId, recordType, recordId, operationType, baseRecordVersion,
            protocolVersion, eventSchemaVersion, keyEpoch, partitionKey, objects,
            retainedMediaObjects, defaultEntryMediaCounts(recordType, operationType));
    }

    private static EntryMediaCounts defaultEntryMediaCounts(String recordType, String operationType) {
        return "ENTRY".equals(recordType) && "UPSERT".equals(operationType)
            ? new EntryMediaCounts(0, 0)
            : null;
    }
}
