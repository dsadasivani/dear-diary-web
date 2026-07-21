package com.deardiary.sync.operation;

import jakarta.validation.Valid;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v2/sync/operations")
public class OperationController {
    private final OperationInitiationService initiationService;
    private final OperationCommitService commitService;
    private final OperationQueryService queryService;

    public OperationController(
            OperationInitiationService initiationService,
            OperationCommitService commitService,
            OperationQueryService queryService) {
        this.initiationService = initiationService;
        this.commitService = commitService;
        this.queryService = queryService;
    }

    @PostMapping("/initiate")
    InitiateOperationResponse initiate(
            Authentication authentication,
            @Valid @RequestBody InitiateOperationRequest request) {
        return initiationService.initiate(authentication.getName(), request);
    }

    @PostMapping("/{operationId}/commit")
    CommitOperationResponse commit(Authentication authentication, @PathVariable java.util.UUID operationId) {
        return commitService.commit(authentication.getName(), operationId);
    }

    @GetMapping("/{operationId}")
    OperationStatusResponse status(Authentication authentication, @PathVariable java.util.UUID operationId) {
        return queryService.find(authentication.getName(), operationId);
    }
}
