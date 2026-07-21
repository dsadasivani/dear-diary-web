package com.deardiary.sync.operation;

import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;

public record OperationObjectRequest(
    @NotBlank String objectKey,
    @NotBlank @Pattern(regexp = "EVENT|MEDIA|THUMBNAIL") String objectKind,
    @NotBlank @Pattern(regexp = "^[0-9a-f]{64}$") String sha256,
    @Min(1) long sizeBytes
) {}
