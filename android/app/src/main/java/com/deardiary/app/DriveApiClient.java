package com.deardiary.app;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URLEncoder;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;
import java.text.SimpleDateFormat;
import org.json.JSONArray;
import org.json.JSONObject;

final class DriveApiClient {
    static final String FILES_ENDPOINT = "https://www.googleapis.com/drive/v3/files";
    static final String UPLOAD_ENDPOINT = "https://www.googleapis.com/upload/drive/v3/files";
    static final String BACKUP_PREFIX = "deardiary-backup-";
    static final String MIME_TYPE = "application/vnd.deardiary.backup+zip";
    private static final int CHUNK_SIZE = 8 * 1024 * 1024;
    private final String token;
    private final BackupSecureStore store;

    static final class BackupFile {
        final String id;
        final String name;
        final String createdTime;
        final long size;
        final String deviceId;

        BackupFile(JSONObject json) {
            id = json.optString("id", "");
            name = json.optString("name", "");
            createdTime = json.optString("createdTime", "");
            size = json.optLong("size", 0);
            deviceId = json.optJSONObject("appProperties") == null
                ? ""
                : json.optJSONObject("appProperties").optString("deviceId", "");
        }
    }

    static final class DriveHttpException extends Exception {
        final int status;
        final String reason;
        DriveHttpException(int status, String reason, String message) {
            super(message);
            this.status = status;
            this.reason = reason;
        }
    }

    DriveApiClient(String token, BackupSecureStore store) {
        this.token = token;
        this.store = store;
    }

    List<BackupFile> listBackups() throws Exception {
        String query = urlEncode("name contains '" + BACKUP_PREFIX + "' and trashed = false");
        String fields = urlEncode("files(id,name,createdTime,modifiedTime,size,appProperties)");
        JSONObject response = requestJson("GET", FILES_ENDPOINT + "?spaces=appDataFolder&q=" + query + "&fields=" + fields + "&orderBy=createdTime%20desc&pageSize=100", null, null);
        JSONArray files = response.optJSONArray("files");
        List<BackupFile> result = new ArrayList<>();
        if (files != null) {
            for (int index = 0; index < files.length(); index++) result.add(new BackupFile(files.getJSONObject(index)));
        }
        return result;
    }

    BackupFile upload(File file, String deviceId, long revision, String parentFileId, int schemaVersion, boolean encrypted, String encryptionKeyId) throws Exception {
        String sessionUrl = store.getString(BackupSecureStore.UPLOAD_URL, "");
        long sessionRevision = store.getLong(BackupSecureStore.UPLOAD_REVISION, -1);
        long offset = store.getLong(BackupSecureStore.UPLOAD_OFFSET, 0);
        if (sessionUrl.isEmpty() || sessionRevision != revision) {
            store.clearUploadSession();
            sessionUrl = initiateUpload(file, deviceId, revision, parentFileId, schemaVersion, encrypted, encryptionKeyId);
            store.putString(BackupSecureStore.UPLOAD_URL, sessionUrl);
            store.putLong(BackupSecureStore.UPLOAD_REVISION, revision);
            offset = 0;
        }

        try (FileInputStream input = new FileInputStream(file)) {
            long skipped = 0;
            while (skipped < offset) {
                long next = input.skip(offset - skipped);
                if (next <= 0) throw new IllegalStateException("Could not resume the staged backup.");
                skipped += next;
            }
            byte[] buffer = new byte[CHUNK_SIZE];
            while (offset < file.length()) {
                int expected = (int) Math.min(CHUNK_SIZE, file.length() - offset);
                int read = readChunk(input, buffer, expected);
                long end = offset + read - 1;
                HttpURLConnection connection = open(sessionUrl, "PUT");
                connection.setRequestProperty("Content-Type", MIME_TYPE);
                connection.setRequestProperty("Content-Length", Integer.toString(read));
                connection.setRequestProperty("Content-Range", "bytes " + offset + "-" + end + "/" + file.length());
                connection.setDoOutput(true);
                connection.setFixedLengthStreamingMode(read);
                try (OutputStream output = connection.getOutputStream()) {
                    output.write(buffer, 0, read);
                }
                int status = connection.getResponseCode();
                if (status == 200 || status == 201) {
                    BackupFile uploaded = new BackupFile(new JSONObject(readBody(connection)));
                    store.clearUploadSession();
                    return uploaded;
                }
                if (status != 308) throw responseException(connection, status);
                offset = end + 1;
                store.putLong(BackupSecureStore.UPLOAD_OFFSET, offset);
                connection.disconnect();
            }
        }
        throw new IllegalStateException("Drive upload completed without file metadata.");
    }

    void prune(List<BackupFile> backups, int keep) {
        for (int index = keep; index < backups.size(); index++) {
            try {
                HttpURLConnection connection = open(FILES_ENDPOINT + "/" + urlEncode(backups.get(index).id), "DELETE");
                int status = connection.getResponseCode();
                if (status != 204 && status != 200) throw responseException(connection, status);
                connection.disconnect();
            } catch (Exception ignored) {
            }
        }
    }

    private String initiateUpload(File file, String deviceId, long revision, String parentFileId, int schemaVersion, boolean encrypted, String encryptionKeyId) throws Exception {
        String fields = urlEncode("id,name,createdTime,modifiedTime,size,appProperties");
        HttpURLConnection connection = open(UPLOAD_ENDPOINT + "?uploadType=resumable&fields=" + fields, "POST");
        connection.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
        connection.setRequestProperty("X-Upload-Content-Type", MIME_TYPE);
        connection.setRequestProperty("X-Upload-Content-Length", Long.toString(file.length()));
        connection.setDoOutput(true);
        JSONObject properties = new JSONObject()
            .put("app", "dear-diary")
            .put("backupSchemaVersion", Integer.toString(schemaVersion))
            .put("deviceId", deviceId)
            .put("contentRevision", Long.toString(revision));
        if (parentFileId != null && !parentFileId.isEmpty()) properties.put("parentBackupFileId", parentFileId);
        properties.put("encrypted", Boolean.toString(encrypted));
        if (encrypted && encryptionKeyId != null && !encryptionKeyId.isEmpty()) {
            properties.put("encryptionVersion", "1");
            properties.put("encryptionKeyId", encryptionKeyId);
        }
        JSONObject body = new JSONObject()
            .put("name", BACKUP_PREFIX + timestampForFilename() + ".ddb")
            .put("mimeType", MIME_TYPE)
            .put("parents", new JSONArray().put("appDataFolder"))
            .put("appProperties", properties);
        byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
        connection.setFixedLengthStreamingMode(bytes.length);
        try (OutputStream output = connection.getOutputStream()) {
            output.write(bytes);
        }
        int status = connection.getResponseCode();
        if (status < 200 || status >= 300) throw responseException(connection, status);
        String location = connection.getHeaderField("Location");
        connection.disconnect();
        if (location == null || location.isEmpty()) throw new IllegalStateException("Drive did not return a resumable upload URL.");
        return location;
    }

    private JSONObject requestJson(String method, String url, String contentType, byte[] body) throws Exception {
        HttpURLConnection connection = open(url, method);
        if (contentType != null) connection.setRequestProperty("Content-Type", contentType);
        if (body != null) {
            connection.setDoOutput(true);
            connection.setFixedLengthStreamingMode(body.length);
            try (OutputStream output = connection.getOutputStream()) { output.write(body); }
        }
        int status = connection.getResponseCode();
        if (status < 200 || status >= 300) throw responseException(connection, status);
        JSONObject result = new JSONObject(readBody(connection));
        connection.disconnect();
        return result;
    }

    private HttpURLConnection open(String url, String method) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(30_000);
        connection.setReadTimeout(60_000);
        connection.setRequestProperty("Authorization", "Bearer " + token);
        return connection;
    }

    private static int readChunk(InputStream input, byte[] buffer, int expected) throws Exception {
        int total = 0;
        while (total < expected) {
            int count = input.read(buffer, total, expected - total);
            if (count < 0) break;
            total += count;
        }
        if (total <= 0) throw new IllegalStateException("The staged backup ended unexpectedly.");
        return total;
    }

    private static String readBody(HttpURLConnection connection) throws Exception {
        InputStream stream = connection.getResponseCode() >= 400 ? connection.getErrorStream() : connection.getInputStream();
        if (stream == null) return "{}";
        try (BufferedInputStream input = new BufferedInputStream(stream); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = input.read(buffer)) >= 0) output.write(buffer, 0, count);
            return new String(output.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    @SuppressWarnings("deprecation")
    private static String urlEncode(String value) throws Exception {
        return URLEncoder.encode(value, "UTF-8");
    }

    private static String timestampForFilename() {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH-mm-ss-SSS'Z'", Locale.US);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return format.format(new Date());
    }

    private static DriveHttpException responseException(HttpURLConnection connection, int status) throws Exception {
        String body = readBody(connection);
        connection.disconnect();
        String reason = "";
        try {
            JSONObject error = new JSONObject(body).optJSONObject("error");
            if (error != null) {
                JSONArray errors = error.optJSONArray("errors");
                if (errors != null && errors.length() > 0) {
                    JSONObject firstError = errors.optJSONObject(0);
                    if (firstError != null) reason = firstError.optString("reason", "");
                }
                JSONArray details = error.optJSONArray("details");
                if (reason.isEmpty() && details != null) {
                    for (int index = 0; index < details.length(); index++) {
                        JSONObject detail = details.optJSONObject(index);
                        if (detail != null && !detail.optString("reason", "").isEmpty()) {
                            reason = detail.optString("reason", "");
                            break;
                        }
                    }
                }
            }
        } catch (Exception ignored) {
        }
        return new DriveHttpException(status, reason, "Drive request failed (" + status + "). " + body);
    }
}
