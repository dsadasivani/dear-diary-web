package com.deardiary.sync.objectstore;

public interface EncryptedObjectStore {
    UploadInstruction initiateUpload(UploadObjectCommand command);
    ObjectMetadata head(ObjectKey objectKey);
    DownloadInstruction createDownload(ObjectKey objectKey);
    void quarantine(ObjectKey objectKey);
    void delete(ObjectKey objectKey);
}
