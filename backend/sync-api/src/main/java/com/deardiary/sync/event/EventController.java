package com.deardiary.sync.event;

import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v2/sync/events")
public class EventController {
    private final EventPullService pullService;

    public EventController(EventPullService pullService) {
        this.pullService = pullService;
    }

    @GetMapping
    PullEventsResponse pull(
            Authentication authentication,
            @RequestParam(defaultValue = "0") long after,
            @RequestParam(defaultValue = "100") int limit) {
        return pullService.pull(authentication.getName(), after, limit);
    }
}
