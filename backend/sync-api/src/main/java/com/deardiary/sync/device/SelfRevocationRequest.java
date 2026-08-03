package com.deardiary.sync.device;

import jakarta.validation.constraints.NotBlank;

public record SelfRevocationRequest(@NotBlank String possessionSignature) {}
