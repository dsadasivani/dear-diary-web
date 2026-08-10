package com.deardiary.sync.quota;

import java.security.Principal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/sync/quota")
public class QuotaController {
    private final QuotaService quotas;

    public QuotaController(QuotaService quotas) {
        this.quotas = quotas;
    }

    @GetMapping
    public QuotaResponse current(Principal principal) {
        return quotas.current(principal.getName());
    }
}
