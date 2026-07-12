package com.deardiary.sync.notification;

public class NotificationPublishException extends RuntimeException {
    private final String code;
    private final boolean retryable;

    public NotificationPublishException(String code, boolean retryable, Throwable cause) {
        super("Realtime wake-up notification could not be published.", cause);
        this.code = code;
        this.retryable = retryable;
    }

    public String code() { return code; }
    public boolean retryable() { return retryable; }
}
