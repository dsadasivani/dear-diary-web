package com.deardiary.sync.objectstore;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.UUID;
import org.junit.jupiter.api.Test;

class ObjectStoreContractTest {
    @Test
    void opaqueKeysAreAccountBoundAndNeverContainUserMetadata() {
        var factory = new ObjectKeyFactory();
        var account = UUID.randomUUID();
        var key = factory.create(account);

        assertThat(factory.belongsTo(account, key)).isTrue();
        assertThat(factory.belongsTo(UUID.randomUUID(), key)).isFalse();
        assertThat(key.value()).doesNotContain("title", "email", "2026-07");
    }

    @Test
    void inMemoryAdapterSupportsUploadVerificationDownloadAndQuarantine() {
        var store = new InMemoryEncryptedObjectStore();
        var key = new ObjectKeyFactory().create(UUID.randomUUID());
        var sha256 = "a".repeat(64);

        var upload = store.initiateUpload(new UploadObjectCommand(key, "EVENT", sha256, 42));
        assertThat(upload.expiresAt()).isAfter(java.time.Instant.now());
        assertThat(store.head(key).sha256()).isEqualTo(sha256);
        store.markUploaded(key);
        assertThat(store.createDownload(key).url().toString()).doesNotContain(sha256);
        store.quarantine(key);
        assertThat(store.head(key).metadata()).containsEntry("quarantined", "true");
        store.delete(key);
        assertThatThrownBy(() -> store.head(key))
            .isInstanceOfSatisfying(ObjectStoreException.class,
                error -> assertThat(error.code()).isEqualTo("OBJECT_MISSING"));
    }
}
