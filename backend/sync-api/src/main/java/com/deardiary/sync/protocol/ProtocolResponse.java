package com.deardiary.sync.protocol;

public record ProtocolResponse(
    int minimumReadProtocolVersion,
    int minimumWriteProtocolVersion,
    int currentProtocolVersion,
    int eventSchemaVersion,
    int snapshotSchemaVersion,
    long maximumEventBytes,
    long maximumMediaBytes,
    FeatureFlags featureFlags
) {
    public record FeatureFlags(
        boolean syncWritesEnabled,
        boolean remotePullEnabled,
        boolean realtimeEnabled,
        boolean snapshotCreationEnabled,
        boolean garbageCollectionEnabled,
        boolean keyRotationEnabled
    ) {}
}
