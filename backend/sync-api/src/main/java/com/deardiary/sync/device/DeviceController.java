package com.deardiary.sync.device;

import jakarta.validation.Valid;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v2/sync/devices")
public class DeviceController {
    private final DeviceRegistrationService registrationService;

    public DeviceController(DeviceRegistrationService registrationService) {
        this.registrationService = registrationService;
    }

    @PostMapping
    ResponseEntity<DeviceRegistrationResponse> register(
            Authentication authentication,
            @Valid @RequestBody DeviceRegistrationRequest request) {
        var result = registrationService.register(authentication.getName(), request);
        return result.created() ? ResponseEntity.status(201).body(result) : ResponseEntity.ok(result);
    }
}
