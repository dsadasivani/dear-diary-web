package com.deardiary.sync.objectstore;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.UUID;
import org.springframework.stereotype.Component;

@Component
public class ObjectKeyFactory {
    public ObjectKey create(UUID accountId) {
        return new ObjectKey(namespace(accountId) + "/objects/" + UUID.randomUUID());
    }

    public boolean belongsTo(UUID accountId, ObjectKey objectKey) {
        return objectKey.value().startsWith(namespace(accountId) + "/objects/");
    }

    private String namespace(UUID accountId) {
        try {
            var digest = MessageDigest.getInstance("SHA-256")
                .digest(accountId.toString().getBytes(StandardCharsets.UTF_8));
            return "accounts/" + HexFormat.of().formatHex(digest, 0, 16);
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is unavailable.", impossible);
        }
    }
}
