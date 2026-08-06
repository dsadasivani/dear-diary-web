package com.deardiary.sync.common;

import com.deardiary.sync.security.CorrelationIdFilter;
import io.micrometer.core.instrument.MeterRegistry;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.ConstraintViolationException;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

@RestControllerAdvice
public class ApiExceptionHandler {
    private final MeterRegistry meters;

    public ApiExceptionHandler(MeterRegistry meters) {
        this.meters = meters;
    }

    @ExceptionHandler(ApiException.class)
    ResponseEntity<ApiErrorResponse> apiException(ApiException error, HttpServletRequest request) {
        recordError(error.code(), error.status());
        return ResponseEntity.status(error.status()).body(new ApiErrorResponse(
            error.code(), error.getMessage(), error.retryable(), error.userActionRequired(),
            correlationId(request), error.details()));
    }

    @ExceptionHandler({MethodArgumentNotValidException.class, ConstraintViolationException.class, HttpMessageNotReadableException.class})
    ResponseEntity<ApiErrorResponse> invalidRequest(Exception ignored, HttpServletRequest request) {
        recordError("INVALID_REQUEST", HttpStatus.BAD_REQUEST);
        return ResponseEntity.badRequest().body(new ApiErrorResponse(
            "INVALID_REQUEST", "The request metadata is invalid.", false, false,
            correlationId(request), Map.of()));
    }

    @ExceptionHandler(Exception.class)
    ResponseEntity<ApiErrorResponse> unexpected(Exception ignored, HttpServletRequest request) {
        recordError("INTERNAL_ERROR", HttpStatus.INTERNAL_SERVER_ERROR);
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(new ApiErrorResponse(
            "INTERNAL_ERROR", "The request could not be completed safely.", true, false,
            correlationId(request), Map.of()));
    }

    private String correlationId(HttpServletRequest request) {
        var value = request.getAttribute(CorrelationIdFilter.ATTRIBUTE_NAME);
        return value instanceof String text ? text : "unavailable";
    }

    private void recordError(String errorCode, HttpStatus status) {
        meters.counter("sync_api_error_total", "error_code", errorCode,
            "status", Integer.toString(status.value())).increment();
    }
}
