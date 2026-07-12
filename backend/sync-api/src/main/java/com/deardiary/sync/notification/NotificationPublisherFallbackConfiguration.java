package com.deardiary.sync.notification;

import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class NotificationPublisherFallbackConfiguration {
    @Bean
    @ConditionalOnMissingBean(SyncNotificationPublisher.class)
    SyncNotificationPublisher disabledNotificationPublisher() {
        return notification -> {
            throw new NotificationPublishException("NOTIFICATION_PUBLISHER_DISABLED", false, null);
        };
    }
}
