package com.deardiary.sync.protocol;

public record ProtocolResponse(
    int minimumReadProtocolVersion,
    int minimumWriteProtocolVersion,
    int currentProtocolVersion,
    int eventSchemaVersion,
    int snapshotSchemaVersion,
    long maximumEventBytes,
    long maximumMediaBytes,
    String minimumSupportedAppVersion,
    int syncV2RolloutPercentage,
    int rolloutSaltVersion,
    boolean emergencyMode,
    FeatureFlags featureFlags
) {
    public record FeatureFlags(
        boolean syncWritesEnabled,
        boolean remotePullEnabled,
        boolean realtimeEnabled,
        boolean snapshotCreationEnabled,
        boolean garbageCollectionEnabled,
        boolean mediaUploadEnabled,
        boolean archiveHydrationEnabled,
        boolean keyRotationEnabled,
        boolean deviceRevocationEnabled,
        boolean primaryRecoveryEnabled,
        boolean companionPairingEnabled
    ) {}
}
