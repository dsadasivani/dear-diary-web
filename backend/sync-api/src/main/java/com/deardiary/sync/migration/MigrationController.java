package com.deardiary.sync.migration;

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
@RequestMapping("/api/v2/sync/migrations")
public class MigrationController {
    private final MigrationService migrations;
    public MigrationController(MigrationService migrations) { this.migrations = migrations; }

    @PostMapping("/begin")
    MigrationResponse begin(Authentication auth, @Valid @RequestBody BeginMigrationRequest request) {
        return migrations.begin(auth.getName(), request);
    }

    @PostMapping("/{migrationId}/advance")
    MigrationResponse advance(Authentication auth, @PathVariable UUID migrationId,
            @Valid @RequestBody AdvanceMigrationRequest request) {
        return migrations.advance(auth.getName(), migrationId, request);
    }

    @PostMapping("/{migrationId}/rollback")
    MigrationResponse rollback(Authentication auth, @PathVariable UUID migrationId, @RequestParam UUID deviceId) {
        return migrations.rollback(auth.getName(), migrationId, deviceId);
    }

    @GetMapping("/{migrationId}")
    MigrationResponse get(Authentication auth, @PathVariable UUID migrationId) {
        return migrations.get(auth.getName(), migrationId);
    }
}
