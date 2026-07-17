package com.deardiary.sync.keypackage;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import java.util.UUID;

public record ApplyDeviceKeyPackageRequest(@NotNull UUID deviceId, @NotBlank String possessionSignature) {}
