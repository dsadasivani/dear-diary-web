package com.deardiary.sync.config;

import static jakarta.servlet.DispatcherType.ERROR;

import com.deardiary.sync.security.CorrelationIdFilter;
import com.deardiary.sync.security.SecurityErrorWriter;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.server.resource.web.authentication.BearerTokenAuthenticationFilter;
import org.springframework.security.web.SecurityFilterChain;

@Configuration
public class SecurityConfig {
    @Bean
    SecurityFilterChain securityFilterChain(
            HttpSecurity http,
            ObjectProvider<JwtDecoder> jwtDecoderProvider,
            SecurityErrorWriter errorWriter,
            CorrelationIdFilter correlationIdFilter) throws Exception {
        var jwtDecoder = jwtDecoderProvider.getIfAvailable();
        http
            .csrf(csrf -> csrf.disable())
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
}
