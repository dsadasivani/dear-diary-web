package com.deardiary.sync.security;

import java.util.ArrayList;
import java.util.List;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.oauth2.core.DelegatingOAuth2TokenValidator;
import org.springframework.security.oauth2.core.OAuth2Error;
import org.springframework.security.oauth2.core.OAuth2TokenValidator;
import org.springframework.security.oauth2.core.OAuth2TokenValidatorResult;
import org.springframework.security.oauth2.jose.jws.SignatureAlgorithm;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtClaimValidator;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtValidators;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;

@Configuration
@EnableConfigurationProperties(SyncJwtProperties.class)
@ConditionalOnProperty(name = "sync.security.jwt.enabled", havingValue = "true")
public class SupabaseJwtConfiguration {
    private static final OAuth2Error INVALID_USER_TOKEN = new OAuth2Error(
        "invalid_token", "Only authenticated user tokens are accepted.", null);

    @Bean
    JwtDecoder jwtDecoder(SyncJwtProperties properties) {
        var decoder = NimbusJwtDecoder.withJwkSetUri(properties.resolvedJwkSetUri())
            .jwsAlgorithms(algorithms -> {
                algorithms.add(SignatureAlgorithm.RS256);
                algorithms.add(SignatureAlgorithm.ES256);
            })
            .build();
        var validators = new ArrayList<OAuth2TokenValidator<Jwt>>();
        validators.add(JwtValidators.createDefaultWithIssuer(properties.issuerUri()));
        if (properties.audience() != null && !properties.audience().isBlank()) {
            validators.add(new JwtClaimValidator<List<String>>("aud", audience -> (
                audience != null && audience.contains(properties.audience())
            )));
        }
        validators.add(jwt -> {
            var subject = jwt.getSubject();
            var role = jwt.getClaimAsString("role");
            return subject != null && !subject.isBlank() && "authenticated".equals(role)
                ? OAuth2TokenValidatorResult.success()
                : OAuth2TokenValidatorResult.failure(INVALID_USER_TOKEN);
        });
        decoder.setJwtValidator(new DelegatingOAuth2TokenValidator<>(validators));
        return decoder;
    }
}
