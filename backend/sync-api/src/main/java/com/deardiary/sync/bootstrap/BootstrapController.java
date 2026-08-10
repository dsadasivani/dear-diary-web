package com.deardiary.sync.bootstrap;

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
@RequestMapping("/api/sync")
public class BootstrapController {
    private final BootstrapService bootstraps;

    public BootstrapController(BootstrapService bootstraps) {
        this.bootstraps = bootstraps;
    }

    @GetMapping("/bootstrap-readiness")
    BootstrapReadinessResponse readiness(
            Authentication authentication, @RequestParam UUID deviceId) {
        return bootstraps.readiness(authentication.getName(), deviceId);
    }

    @PostMapping("/bootstraps")
    BootstrapManifestResponse create(
            Authentication authentication, @Valid @RequestBody BootstrapRequests.Create request) {
        return bootstraps.create(authentication.getName(), request);
    }

    @GetMapping("/bootstraps/{bootstrapId}")
    BootstrapManifestResponse get(
            Authentication authentication, @PathVariable UUID bootstrapId) {
        return bootstraps.get(authentication.getName(), bootstrapId);
    }

    @PostMapping("/bootstraps/{bootstrapId}/complete")
    BootstrapManifestResponse complete(
            Authentication authentication,
            @PathVariable UUID bootstrapId,
            @Valid @RequestBody BootstrapRequests.Complete request) {
        return bootstraps.complete(authentication.getName(), bootstrapId, request);
    }
}
