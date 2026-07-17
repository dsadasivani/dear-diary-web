package com.deardiary.sync.device;

import jakarta.validation.Valid;
import java.util.List;
import java.util.UUID;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v2/sync/devices")
public class DeviceController {
    private final DeviceRegistrationService registrationService;
    private final DeviceManagementService managementService;

    public DeviceController(DeviceRegistrationService registrationService, DeviceManagementService managementService) {
        this.registrationService = registrationService;
        this.managementService = managementService;
    }

    @PostMapping
    ResponseEntity<DeviceRegistrationResponse> register(
            Authentication authentication,
            @Valid @RequestBody DeviceRegistrationRequest request) {
        var result = registrationService.register(authentication.getName(), request);
        return result.created() ? ResponseEntity.status(201).body(result) : ResponseEntity.ok(result);
    }

    @GetMapping
    List<DeviceResponse> list(Authentication authentication, @RequestParam UUID requestingDeviceId) {
        return managementService.list(authentication.getName(), requestingDeviceId);
    }
}
