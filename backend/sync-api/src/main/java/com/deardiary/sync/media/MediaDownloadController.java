package com.deardiary.sync.media;

import java.util.UUID;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v2/sync/media")
public class MediaDownloadController {
    private final MediaDownloadService service;

    public MediaDownloadController(MediaDownloadService service) {
        this.service = service;
    }

    @GetMapping("/{objectId}")
    MediaDownloadResponse get(Authentication authentication, @PathVariable UUID objectId) {
        return service.get(authentication.getName(), objectId);
    }
}
