package com.deardiary.sync.keypackage;

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
@RequestMapping("/api/v2/sync/key-packages")
public class KeyPackageController {
    private final KeyPackageService packages;
    public KeyPackageController(KeyPackageService packages) { this.packages = packages; }
    @PostMapping("/initiate") KeyPackageResponse initiate(Authentication auth, @Valid @RequestBody KeyPackageRequest request) {
        return packages.initiate(auth.getName(), request);
    }
    @PostMapping("/{id}/register") KeyPackageResponse register(Authentication auth, @PathVariable UUID id,
            @RequestParam UUID creatorDeviceId) { return packages.register(auth.getName(), id, creatorDeviceId); }
    @GetMapping("/recovery/latest") KeyPackageResponse latestRecovery(Authentication auth) {
        return packages.latestRecovery(auth.getName());
    }
}
