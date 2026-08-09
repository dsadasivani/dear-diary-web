package com.deardiary.sync.common;

import static org.assertj.core.api.Assertions.assertThat;

import com.deardiary.sync.security.CorrelationIdFilter;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.mock.web.MockHttpServletRequest;

class ApiExceptionHandlerTest {
    @Test
    void recordsApiErrorsWithLowCardinalityOperationalTags() {
        var meters = new SimpleMeterRegistry();
        var handler = new ApiExceptionHandler(meters);
        var request = new MockHttpServletRequest();
        request.setAttribute(CorrelationIdFilter.ATTRIBUTE_NAME, "safe-correlation-id");

        var response = handler.apiException(
            new ApiException("HASH_MISMATCH", HttpStatus.CONFLICT, "Encrypted content failed validation."),
            request);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(response.getBody().correlationId()).isEqualTo("safe-correlation-id");
        assertThat(meters.get("sync_api_error_total")
            .tags("error_code", "HASH_MISMATCH", "status", "409")
            .counter().count()).isEqualTo(1);
    }
}
