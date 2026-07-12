package com.deardiary.sync.operation;

import jakarta.validation.Valid;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v2/sync/operations")
public class OperationController {
    private final OperationInitiationService initiationService;

    public OperationController(OperationInitiationService initiationService) {
        this.initiationService = initiationService;
    }

    @PostMapping("/initiate")
    InitiateOperationResponse initiate(
            Authentication authentication,
            @Valid @RequestBody InitiateOperationRequest request) {
        return initiationService.initiate(authentication.getName(), request);
    }
}
