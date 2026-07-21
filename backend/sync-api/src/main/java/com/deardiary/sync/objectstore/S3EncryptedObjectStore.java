package com.deardiary.sync.objectstore;

import java.time.Clock;
import java.time.Instant;
import java.util.Map;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.DeleteObjectRequest;
import software.amazon.awssdk.services.s3.model.GetObjectRequest;
import software.amazon.awssdk.services.s3.model.HeadObjectRequest;
import software.amazon.awssdk.services.s3.model.PutObjectRequest;
import software.amazon.awssdk.services.s3.model.PutObjectTaggingRequest;
import software.amazon.awssdk.services.s3.model.S3Exception;
import software.amazon.awssdk.services.s3.model.Tag;
import software.amazon.awssdk.services.s3.model.Tagging;
import software.amazon.awssdk.services.s3.presigner.S3Presigner;
import software.amazon.awssdk.services.s3.presigner.model.GetObjectPresignRequest;
import software.amazon.awssdk.services.s3.presigner.model.PutObjectPresignRequest;

@Component
@ConditionalOnProperty(name = "sync.object-store.enabled", havingValue = "true")
public class S3EncryptedObjectStore implements EncryptedObjectStore {
    private final S3Client client;
    private final S3Presigner presigner;
    private final ObjectStoreProperties properties;
    private final Clock clock;

    public S3EncryptedObjectStore(
            S3Client client,
            S3Presigner presigner,
            ObjectStoreProperties properties,
            Clock clock) {
        this.client = client;
        this.presigner = presigner;
        this.properties = properties;
        this.clock = clock;
    }

    @Override
    public UploadInstruction initiateUpload(UploadObjectCommand command) {
        try {
            var request = PutObjectRequest.builder()
                .bucket(properties.bucket())
                .key(command.objectKey().value())
                .contentLength(command.sizeBytes())
                .metadata(Map.of("sha256", command.sha256(), "object-kind", command.objectKind()))
                .build();
            var signed = presigner.presignPutObject(PutObjectPresignRequest.builder()
                .signatureDuration(properties.signedUrlTtl())
                .putObjectRequest(request)
                .build());
            return new UploadInstruction(
                signed.url().toURI(), signed.signedHeaders(), Instant.now(clock).plus(properties.signedUrlTtl()));
        } catch (Exception error) {
            throw map(error);
        }
    }

    @Override
    public ObjectMetadata head(ObjectKey objectKey) {
        try {
            var response = client.headObject(HeadObjectRequest.builder()
                .bucket(properties.bucket()).key(objectKey.value()).build());
            return new ObjectMetadata(
                objectKey, response.contentLength(), response.metadata().get("sha256"), response.metadata());
        } catch (Exception error) {
            throw map(error);
        }
    }

    @Override
    public DownloadInstruction createDownload(ObjectKey objectKey) {
        try {
            var signed = presigner.presignGetObject(GetObjectPresignRequest.builder()
                .signatureDuration(properties.signedUrlTtl())
                .getObjectRequest(GetObjectRequest.builder()
                    .bucket(properties.bucket()).key(objectKey.value()).build())
                .build());
            return new DownloadInstruction(signed.url().toURI(), Instant.now(clock).plus(properties.signedUrlTtl()));
        } catch (Exception error) {
            throw map(error);
        }
    }

    @Override
    public void quarantine(ObjectKey objectKey) {
        try {
            client.putObjectTagging(PutObjectTaggingRequest.builder()
                .bucket(properties.bucket()).key(objectKey.value())
                .tagging(Tagging.builder().tagSet(Tag.builder().key("quarantined").value("true").build()).build())
                .build());
        } catch (Exception error) {
            throw map(error);
        }
    }

    @Override
    public void delete(ObjectKey objectKey) {
        try {
            client.deleteObject(DeleteObjectRequest.builder()
                .bucket(properties.bucket()).key(objectKey.value()).build());
        } catch (Exception error) {
            throw map(error);
        }
    }

    private ObjectStoreException map(Exception error) {
        if (error instanceof S3Exception s3) {
            var status = s3.statusCode();
            if (status == 404) return new ObjectStoreException("OBJECT_MISSING", false, status, error);
            if (status == 429 || status >= 500) return new ObjectStoreException("OBJECT_STORE_UNAVAILABLE", true, status, error);
            if (status == 507) return new ObjectStoreException("STORAGE_QUOTA_EXCEEDED", false, status, error);
        }
        return new ObjectStoreException("OBJECT_STORE_UNAVAILABLE", true, error);
    }
}
