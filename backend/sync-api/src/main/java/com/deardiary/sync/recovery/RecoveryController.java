package com.deardiary.sync.recovery;

import jakarta.validation.Valid;
import java.util.UUID;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v2/sync/recovery")
public class RecoveryController {
    private final RecoveryService recovery;
    public RecoveryController(RecoveryService recovery) { this.recovery = recovery; }
    @PostMapping("/begin") RecoveryResponse begin(Authentication auth, @Valid @RequestBody RecoveryRequests.Begin request) {
        return recovery.begin(auth.getName(), request);
    }
    @PostMapping("/approve") RecoveryResponse approve(Authentication auth, @RequestParam UUID attemptId,
            @RequestParam UUID recoveryDeviceId) { return recovery.approve(auth.getName(), attemptId, recoveryDeviceId); }
    @GetMapping("/package") RecoveryResponse keyPackage(Authentication auth, @RequestParam UUID attemptId,
            @RequestParam UUID recoveryDeviceId) { return recovery.packageForRecovery(auth.getName(), attemptId, recoveryDeviceId); }
    @PostMapping("/key-persisted") RecoveryResponse persisted(Authentication auth, @RequestParam UUID attemptId,
            @Valid @RequestBody RecoveryRequests.Persisted request) {
        return recovery.markLocalKeyPersisted(auth.getName(), attemptId, request);
    }
    @PostMapping("/finalize") RecoveryResponse finalizeRecovery(Authentication auth, @RequestParam UUID attemptId,
            @RequestParam UUID recoveryDeviceId) { return recovery.finalizeRecovery(auth.getName(), attemptId, recoveryDeviceId); }
    @GetMapping RecoveryResponse get(Authentication auth) { return recovery.get(auth.getName()); }
}
