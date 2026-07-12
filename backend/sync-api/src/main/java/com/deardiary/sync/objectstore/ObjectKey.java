package com.deardiary.sync.objectstore;

import java.util.Objects;

public record ObjectKey(String value) {
    public ObjectKey {
        Objects.requireNonNull(value, "value");
        if (!value.matches("^accounts/[0-9a-f]{32}/objects/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")) {
            throw new IllegalArgumentException("Invalid opaque object key.");
        }
    }
}
