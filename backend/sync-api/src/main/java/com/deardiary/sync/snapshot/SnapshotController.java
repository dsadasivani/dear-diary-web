package com.deardiary.sync.snapshot;

import jakarta.validation.Valid;
import java.util.UUID;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v2/sync/snapshots")
public class SnapshotController {
    private final SnapshotService snapshots;

    public SnapshotController(SnapshotService snapshots) {
        this.snapshots = snapshots;
    }

    @PostMapping("/initiate")
    InitiateSnapshotResponse initiate(
            Authentication authentication,
            @Valid @RequestBody InitiateSnapshotRequest request) {
        return snapshots.initiate(authentication.getName(), request);
    }

    @PostMapping("/{snapshotId}/register")
    SnapshotResponse register(
            Authentication authentication,
            @PathVariable UUID snapshotId,
            @RequestParam UUID deviceId) {
        return snapshots.register(authentication.getName(), snapshotId, deviceId);
    }

    @GetMapping("/latest")
    SnapshotResponse latest(
            Authentication authentication,
            @RequestParam(defaultValue = SnapshotService.ACCOUNT_PARTITION) String partitionKey,
            @RequestParam int snapshotSchemaVersion) {
        return snapshots.latest(authentication.getName(), partitionKey, snapshotSchemaVersion);
    }
}
