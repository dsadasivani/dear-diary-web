package com.deardiary.sync.objectstore;

import java.net.URI;
import java.time.Instant;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

public class InMemoryEncryptedObjectStore implements EncryptedObjectStore {
    private final Map<ObjectKey, ObjectMetadata> objects = new ConcurrentHashMap<>();

    @Override
    public UploadInstruction initiateUpload(UploadObjectCommand command) {
        objects.put(command.objectKey(), new ObjectMetadata(
            command.objectKey(), command.sizeBytes(), command.sha256(),
            Map.of("object-kind", command.objectKind(), "upload-status", "pending")));
        return new UploadInstruction(
            URI.create("https://object-store.invalid/upload/" + command.objectKey().value()),
            Map.of(), Instant.now().plusSeconds(300));
    }

    public void markUploaded(ObjectKey key) {
        var current = head(key);
        objects.put(key, new ObjectMetadata(
            key, current.sizeBytes(), current.sha256(), Map.of("upload-status", "uploaded")));
    }

    @Override
    public ObjectMetadata head(ObjectKey objectKey) {
        var value = objects.get(objectKey);
        if (value == null) throw new ObjectStoreException("OBJECT_MISSING", false, null);
        return value;
    }

    @Override
    public DownloadInstruction createDownload(ObjectKey objectKey) {
        head(objectKey);
        return new DownloadInstruction(
            URI.create("https://object-store.invalid/download/" + objectKey.value()),
            Instant.now().plusSeconds(300));
    }

    @Override
    public void quarantine(ObjectKey objectKey) {
        var current = head(objectKey);
        objects.put(objectKey, new ObjectMetadata(
            objectKey, current.sizeBytes(), current.sha256(), Map.of("quarantined", "true")));
    }

    @Override
    public void delete(ObjectKey objectKey) {
        objects.remove(objectKey);
    }
}
