package com.deardiary.sync.security;

import com.deardiary.sync.common.ApiErrorResponse;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.Map;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;

@Component
public class SecurityErrorWriter {
    private final ObjectMapper objectMapper;

    public SecurityErrorWriter(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    public void writeUnauthorized(
            HttpServletRequest request,
            HttpServletResponse response,
            Exception ignored) throws IOException {
        write(request, response, HttpServletResponse.SC_UNAUTHORIZED, new ApiErrorResponse(
            "AUTH_INVALID",
            "A valid user access token is required.",
            false,
            true,
            correlationId(request),
            Map.of()
        ));
    }

    public void writeForbidden(
            HttpServletRequest request,
            HttpServletResponse response,
            Exception ignored) throws IOException {
        write(request, response, HttpServletResponse.SC_FORBIDDEN, new ApiErrorResponse(
            "ACCESS_DENIED",
            "The authenticated user cannot access this resource.",
            false,
            true,
            correlationId(request),
            Map.of()
        ));
    }

    private void write(
            HttpServletRequest request,
            HttpServletResponse response,
            int status,
            ApiErrorResponse body) throws IOException {
        response.setStatus(status);
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        objectMapper.writeValue(response.getOutputStream(), body);
    }

    private String correlationId(HttpServletRequest request) {
        var value = request.getAttribute(CorrelationIdFilter.ATTRIBUTE_NAME);
        return value instanceof String text ? text : "unavailable";
    }
}
