package com.deardiary.sync.rotation;

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
@RequestMapping("/api/v2/sync/rotations")
public class RotationController {
    private final RotationService rotations;
    public RotationController(RotationService rotations) { this.rotations = rotations; }
    @PostMapping("/begin") RotationResponse begin(Authentication auth, @Valid @RequestBody RotationRequests.Begin request) {
        return rotations.begin(auth.getName(), request); }
    @PostMapping("/{id}/advance") RotationResponse advance(Authentication auth, @PathVariable UUID id,
            @Valid @RequestBody RotationRequests.Advance request) { return rotations.advance(auth.getName(), id, request); }
    @PostMapping("/{id}/commit-epoch") RotationResponse commit(Authentication auth, @PathVariable UUID id,
            @RequestParam UUID deviceId) { return rotations.commitServerEpoch(auth.getName(), id, deviceId); }
    @PostMapping("/{id}/local-committed") RotationResponse local(Authentication auth, @PathVariable UUID id,
            @Valid @RequestBody RotationRequests.LocalCommitted request) { return rotations.localCommitted(auth.getName(), id, request); }
    @GetMapping("/{id}") RotationResponse get(Authentication auth, @PathVariable UUID id) { return rotations.get(auth.getName(), id); }
}
