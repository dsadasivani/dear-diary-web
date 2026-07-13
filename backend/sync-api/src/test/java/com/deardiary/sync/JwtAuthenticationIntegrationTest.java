package com.deardiary.sync;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.nimbusds.jose.JOSEException;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.RSASSASigner;
import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.RSAKey;
import com.nimbusds.jose.jwk.gen.RSAKeyGenerator;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Date;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpHeaders;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import com.deardiary.sync.protocol.ProtocolResponse;
import com.deardiary.sync.protocol.ProtocolService;
import static org.mockito.Mockito.when;

@SpringBootTest
@AutoConfigureMockMvc
class JwtAuthenticationIntegrationTest {
    private static final String KEY_ID = "test-signing-key";
    private static final RSAKey TRUSTED_KEY = generateKey();
    private static final RSAKey UNTRUSTED_KEY = generateKey();
    private static final HttpServer JWKS_SERVER = startJwksServer();

    @Autowired
    private MockMvc mockMvc;

    @MockitoBean
    private ProtocolService protocolService;

    @DynamicPropertySource
    static void jwtProperties(DynamicPropertyRegistry registry) {
        registry.add("sync.security.jwt.enabled", () -> "true");
        registry.add("sync.security.jwt.issuer-uri", JwtAuthenticationIntegrationTest::issuer);
        registry.add("sync.security.jwt.jwk-set-uri", JwtAuthenticationIntegrationTest::jwkSetUri);
        registry.add("sync.security.jwt.audience", () -> "authenticated");
    }

    @AfterAll
    static void stopJwksServer() {
        JWKS_SERVER.stop(0);
    }

    @Test
    void missingTokenReturnsStablePrivacySafeError() throws Exception {
        mockMvc.perform(get("/api/v2/sync/protocol").header("X-Correlation-Id", "request_12345678"))
            .andExpect(status().isUnauthorized())
            .andExpect(header().string("X-Correlation-Id", "request_12345678"))
            .andExpect(jsonPath("$.code").value("AUTH_INVALID"))
            .andExpect(jsonPath("$.retryable").value(false))
            .andExpect(jsonPath("$.userActionRequired").value(true))
            .andExpect(jsonPath("$.correlationId").value("request_12345678"))
            .andExpect(jsonPath("$.details").isEmpty());
    }

    @Test
    void malformedTokenIsRejected() throws Exception {
        expectUnauthorized("not-a-jwt");
    }

    @Test
    void invalidSignatureIsRejected() throws Exception {
        expectUnauthorized(token(UNTRUSTED_KEY, "user-1", "authenticated", "authenticated", Instant.now().plusSeconds(300)));
    }

    @Test
    void expiredTokenIsRejected() throws Exception {
        expectUnauthorized(token(TRUSTED_KEY, "user-1", "authenticated", "authenticated", Instant.now().minusSeconds(300)));
    }

    @Test
    void wrongAudienceIsRejected() throws Exception {
        expectUnauthorized(token(TRUSTED_KEY, "user-1", "authenticated", "another-api", Instant.now().plusSeconds(300)));
    }

    @Test
    void wrongIssuerIsRejected() throws Exception {
        expectUnauthorized(token(
            TRUSTED_KEY, "user-1", "authenticated", "authenticated",
            Instant.now().plusSeconds(300), "https://another-project.supabase.co/auth/v1"));
    }

    @Test
    void serviceRoleTokenIsRejected() throws Exception {
        expectUnauthorized(token(TRUSTED_KEY, "service", "service_role", "authenticated", Instant.now().plusSeconds(300)));
    }

    @Test
    void tokenWithoutUserSubjectIsRejected() throws Exception {
        expectUnauthorized(token(TRUSTED_KEY, null, "authenticated", "authenticated", Instant.now().plusSeconds(300)));
    }

    @Test
    void validAuthenticatedUserTokenPassesTheSecurityBoundary() throws Exception {
        when(protocolService.current()).thenReturn(new ProtocolResponse(
            2, 2, 2, 2, 2, 10_485_760, 104_857_600, 104_857_600,
            "0.0.0", 0, 1, false,
            new ProtocolResponse.FeatureFlags(true, true, true, false, false, true, true, false, false, false, false)));
        mockMvc.perform(get("/api/v2/sync/protocol")
                .header(HttpHeaders.AUTHORIZATION, bearer(token(
                    TRUSTED_KEY, "user-1", "authenticated", "authenticated", Instant.now().plusSeconds(300)))))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.currentProtocolVersion").value(2));
    }

    private void expectUnauthorized(String token) throws Exception {
        mockMvc.perform(get("/api/v2/sync/protocol").header(HttpHeaders.AUTHORIZATION, bearer(token)))
            .andExpect(status().isUnauthorized())
            .andExpect(jsonPath("$.code").value("AUTH_INVALID"))
            .andExpect(jsonPath("$.message").value("A valid user access token is required."));
    }

    private static String bearer(String token) {
        return "Bearer " + token;
    }

    private static String token(
            RSAKey signingKey,
            String subject,
            String role,
            String audience,
            Instant expiresAt) throws JOSEException {
        return token(signingKey, subject, role, audience, expiresAt, issuer());
    }

    private static String token(
            RSAKey signingKey,
            String subject,
            String role,
            String audience,
            Instant expiresAt,
            String issuer) throws JOSEException {
        var claims = new JWTClaimsSet.Builder()
            .issuer(issuer)
            .subject(subject)
            .audience(audience)
            .issueTime(Date.from(Instant.now().minusSeconds(5)))
            .expirationTime(Date.from(expiresAt))
            .claim("role", role)
            .build();
        var jwt = new SignedJWT(
            new JWSHeader.Builder(JWSAlgorithm.RS256).keyID(KEY_ID).build(),
            claims
        );
        jwt.sign(new RSASSASigner(signingKey));
        return jwt.serialize();
    }

    private static RSAKey generateKey() {
        try {
            return new RSAKeyGenerator(2048).keyID(KEY_ID).generate();
        } catch (JOSEException error) {
            throw new ExceptionInInitializerError(error);
        }
    }

    private static HttpServer startJwksServer() {
        try {
            var server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            server.createContext("/auth/v1/.well-known/jwks.json", exchange -> {
                var body = new JWKSet(TRUSTED_KEY.toPublicJWK()).toString().getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Content-Type", "application/json");
                exchange.sendResponseHeaders(200, body.length);
                try (var output = exchange.getResponseBody()) {
                    output.write(body);
                }
            });
            server.start();
            return server;
        } catch (IOException error) {
            throw new ExceptionInInitializerError(error);
        }
    }

    private static String issuer() {
        return "http://127.0.0.1:" + JWKS_SERVER.getAddress().getPort() + "/auth/v1";
    }

    private static String jwkSetUri() {
        return issuer() + "/.well-known/jwks.json";
    }
}
