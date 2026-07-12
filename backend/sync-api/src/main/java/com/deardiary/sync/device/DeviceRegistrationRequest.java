package com.deardiary.sync.device;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.util.UUID;

public record DeviceRegistrationRequest(
    @NotNull UUID deviceId,
    @NotBlank @Size(max = 32768) String devicePublicKey,
    @NotBlank @Pattern(regexp = "PRIMARY|COMPANION") String deviceRole,
    @Min(1) @Max(1000) int protocolVersion,
    @Size(max = 128) String appVersion
) {}
