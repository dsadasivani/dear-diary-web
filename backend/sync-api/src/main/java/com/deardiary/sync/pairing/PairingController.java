package com.deardiary.sync.pairing;

import jakarta.validation.Valid;
import java.util.UUID;
import java.util.List;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v2/sync/pairings")
public class PairingController {
    private final PairingService pairings;
    public PairingController(PairingService pairings) { this.pairings = pairings; }
    @PostMapping PairingResponse create(Authentication auth, @Valid @RequestBody PairingRequests.Create request) {
        return pairings.create(auth.getName(), request);
    }
    @GetMapping("/pending") List<PairingResponse> pending(Authentication auth,
            @RequestParam UUID approverDeviceId) {
        return pairings.listPending(auth.getName(), approverDeviceId);
    }
    @PostMapping("/{id}/approve") PairingResponse approve(Authentication auth, @PathVariable UUID id,
            @Valid @RequestBody PairingRequests.Approve request) { return pairings.approve(auth.getName(), id, request); }
    @PostMapping("/{id}/register-package") PairingResponse register(Authentication auth, @PathVariable UUID id,
            @RequestParam UUID approverDeviceId) { return pairings.registerPackage(auth.getName(), id, approverDeviceId); }
    @GetMapping("/{id}") PairingResponse status(Authentication auth, @PathVariable UUID id,
            @RequestParam UUID requestedDeviceId) { return pairings.status(auth.getName(), id, requestedDeviceId); }
    @PostMapping("/{id}/complete") PairingResponse complete(Authentication auth, @PathVariable UUID id,
            @Valid @RequestBody PairingRequests.Complete request) { return pairings.complete(auth.getName(), id, request); }
}
