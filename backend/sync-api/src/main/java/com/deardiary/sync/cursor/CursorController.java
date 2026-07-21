package com.deardiary.sync.cursor;

import jakarta.validation.Valid;
import java.util.UUID;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v2/sync/devices/{deviceId}/cursor")
public class CursorController {
    private final CursorService cursorService;

    public CursorController(CursorService cursorService) {
        this.cursorService = cursorService;
    }

    @PostMapping
    CursorAcknowledgmentResponse acknowledge(
            Authentication authentication,
            @PathVariable UUID deviceId,
            @Valid @RequestBody CursorAcknowledgmentRequest request) {
        return cursorService.acknowledge(authentication.getName(), deviceId, request.lastAppliedSequence());
    }
}
