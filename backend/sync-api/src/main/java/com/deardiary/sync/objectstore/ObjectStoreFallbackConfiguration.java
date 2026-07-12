package com.deardiary.sync.objectstore;

import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class ObjectStoreFallbackConfiguration {
    @Bean
    @ConditionalOnMissingBean(EncryptedObjectStore.class)
    EncryptedObjectStore disabledEncryptedObjectStore() {
        return new EncryptedObjectStore() {
            private ObjectStoreException disabled() {
                return new ObjectStoreException("OBJECT_STORE_DISABLED", false, null);
            }
            @Override public UploadInstruction initiateUpload(UploadObjectCommand command) { throw disabled(); }
            @Override public ObjectMetadata head(ObjectKey objectKey) { throw disabled(); }
            @Override public DownloadInstruction createDownload(ObjectKey objectKey) { throw disabled(); }
            @Override public void quarantine(ObjectKey objectKey) { throw disabled(); }
            @Override public void delete(ObjectKey objectKey) { throw disabled(); }
        };
    }
}
