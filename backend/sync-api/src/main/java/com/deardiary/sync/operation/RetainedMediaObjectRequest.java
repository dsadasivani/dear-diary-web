package com.deardiary.sync.operation;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;

public record RetainedMediaObjectRequest(
    @NotBlank String objectKey,
    @NotBlank @Pattern(regexp = "MEDIA|THUMBNAIL") String objectKind
) {}
