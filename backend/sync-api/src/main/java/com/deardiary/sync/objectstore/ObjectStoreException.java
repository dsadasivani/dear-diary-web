package com.deardiary.sync.objectstore;

public class ObjectStoreException extends RuntimeException {
    private final String code;
    private final boolean retryable;

    public ObjectStoreException(String code, boolean retryable, Throwable cause) {
        super("Encrypted object storage request failed.", cause);
        this.code = code;
        this.retryable = retryable;
    }

    public String code() { return code; }
    public boolean retryable() { return retryable; }
}
