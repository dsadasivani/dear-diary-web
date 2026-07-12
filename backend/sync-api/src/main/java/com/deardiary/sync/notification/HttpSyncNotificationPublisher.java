package com.deardiary.sync.notification;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.stereotype.Component;

@Component
@EnableConfigurationProperties(NotificationPublisherProperties.class)
@ConditionalOnProperty(name = "sync.notification.publisher.enabled", havingValue = "true")
public class HttpSyncNotificationPublisher implements SyncNotificationPublisher {
    private final HttpClient client;
    private final ObjectMapper objectMapper;
    private final NotificationPublisherProperties properties;

    public HttpSyncNotificationPublisher(ObjectMapper objectMapper, NotificationPublisherProperties properties) {
        this.client = HttpClient.newBuilder().connectTimeout(properties.timeout()).build();
        this.objectMapper = objectMapper;
        this.properties = properties;
    }

    @Override
    public void publish(SyncNotification notification) {
        try {
            var body = objectMapper.writeValueAsString(new Payload(
                notification.accountId(), notification.sequence(), notification.type()));
            var request = HttpRequest.newBuilder(properties.endpoint())
                .timeout(properties.timeout())
                .header("Authorization", "Bearer " + properties.bearerToken())
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .build();
            var response = client.send(request, HttpResponse.BodyHandlers.discarding());
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                var retryable = response.statusCode() == 429 || response.statusCode() >= 500;
                throw new NotificationPublishException(
                    retryable ? "NOTIFICATION_PROVIDER_UNAVAILABLE" : "NOTIFICATION_REJECTED", retryable, null);
            }
        } catch (NotificationPublishException error) {
            throw error;
        } catch (Exception error) {
            if (error instanceof InterruptedException) Thread.currentThread().interrupt();
            throw new NotificationPublishException("NOTIFICATION_PROVIDER_UNAVAILABLE", true, error);
        }
    }

    private record Payload(java.util.UUID accountId, long sequence, String type) {}
}
