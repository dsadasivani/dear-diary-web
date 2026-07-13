package com.deardiary.sync.objectstore;

public class ObjectStoreException extends RuntimeException {
    private final String code;
    private final boolean retryable;
    private final Integer statusCode;

    public ObjectStoreException(String code, boolean retryable, Throwable cause) {
        this(code, retryable, null, cause);
    }

    public ObjectStoreException(String code, boolean retryable, Integer statusCode, Throwable cause) {
        super("Encrypted object storage request failed.", cause);
        this.code = code;
        this.retryable = retryable;
        this.statusCode = statusCode;
    }

    public String code() { return code; }
    public boolean retryable() { return retryable; }
    public Integer statusCode() { return statusCode; }
}
