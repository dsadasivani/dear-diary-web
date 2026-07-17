package com.deardiary.sync.config;

import static jakarta.servlet.DispatcherType.ERROR;

import com.deardiary.sync.security.CorrelationIdFilter;
import com.deardiary.sync.security.SecurityErrorWriter;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.server.resource.web.authentication.BearerTokenAuthenticationFilter;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.CorsConfigurationSource;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;

import java.util.Arrays;
import java.util.List;

@Configuration
public class SecurityConfig {
    @Bean
    SecurityFilterChain securityFilterChain(
            HttpSecurity http,
            ObjectProvider<JwtDecoder> jwtDecoderProvider,
            SecurityErrorWriter errorWriter,
            CorrelationIdFilter correlationIdFilter,
            CorsConfigurationSource corsConfigurationSource) throws Exception {
        var jwtDecoder = jwtDecoderProvider.getIfAvailable();
        http
            .csrf(csrf -> csrf.disable())
            .cors(cors -> cors.configurationSource(corsConfigurationSource))
            .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .addFilterBefore(correlationIdFilter, BearerTokenAuthenticationFilter.class)
            .exceptionHandling(exceptions -> exceptions
                .authenticationEntryPoint(errorWriter::writeUnauthorized)
                .accessDeniedHandler(errorWriter::writeForbidden))
            .authorizeHttpRequests(authorize -> {
                authorize
                    .dispatcherTypeMatchers(ERROR).permitAll()
                    .requestMatchers("/actuator/health", "/actuator/health/**").permitAll();
                if (jwtDecoder == null) {
                    authorize.anyRequest().denyAll();
                } else {
                    authorize.requestMatchers("/api/v2/**").authenticated().anyRequest().denyAll();
                }
            });
        if (jwtDecoder != null) {
            http.oauth2ResourceServer(resourceServer -> resourceServer
                .jwt(jwt -> jwt.decoder(jwtDecoder))
                .authenticationEntryPoint(errorWriter::writeUnauthorized)
                .accessDeniedHandler(errorWriter::writeForbidden));
        }
        return http.build();
    }

    @Bean
    CorsConfigurationSource corsConfigurationSource(
            @Value("${sync.cors.allowed-origins:}") String configuredOrigins) {
        var configuration = new CorsConfiguration();
        var origins = Arrays.stream(configuredOrigins.split(","))
            .map(String::trim)
            .filter(origin -> !origin.isEmpty())
            .toList();
        configuration.setAllowedOrigins(origins);
        configuration.setAllowedMethods(List.of("GET", "POST", "PUT", "DELETE", "OPTIONS"));
        configuration.setAllowedHeaders(List.of("Authorization", "Content-Type", "X-Correlation-Id"));
        configuration.setExposedHeaders(List.of("X-Correlation-Id"));
        configuration.setAllowCredentials(false);
        configuration.setMaxAge(3600L);
        var source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/api/v2/**", configuration);
        return source;
    }
}
