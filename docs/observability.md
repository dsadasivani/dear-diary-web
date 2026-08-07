# Grafana Cloud observability

Grafana Cloud is the single monitoring and investigation surface for Loredays. No Grafana,
Prometheus, Loki, Tempo, or Alertmanager service is hosted on a developer machine.

## Signal path

```mermaid
flowchart LR
    CLIENT[React / Capacitor] -->|privacy-safe Faro signals| FARO[Grafana Frontend Observability]
    API[Spring Sync API] -->|OTLP metrics| MIMIR[Grafana Cloud Metrics]
    API -->|OTLP structured logs| LOKI[Grafana Cloud Logs]
    API -->|OTLP sampled traces| TEMPO[Grafana Cloud Traces]
    AWS[AWS ECS / CloudWatch] -->|Grafana AWS integration| GRAFANA[Grafana Cloud]
    FARO --> GRAFANA
    MIMIR --> GRAFANA
    LOKI --> GRAFANA
    TEMPO --> GRAFANA
```

Client requests retain one `X-Correlation-Id` across retries. The API returns that ID and records it
with the active trace and span IDs. Never add diary content, titles, tags, object paths, access tokens,
signed URLs, or raw account/device identifiers to a telemetry attribute.

The Faro client enables only the session lifecycle instrumentation required for the collector's
session header. Automatic console, error, performance, navigation, and web-vitals instrumentation,
page/browser metadata, persistent sessions, and geolocation remain disabled. Application signals
still use only names and attributes allowlisted by `Telemetry.ts` and the sanitized error type. The
collector still needs exact CORS origins and an appropriate retention policy.

## One-time Grafana Cloud setup

1. In the Grafana Cloud stack, open **Connections > OpenTelemetry > Configure**. Generate an access
   policy token with only metrics, logs, and traces write scopes. Copy the values of
   `OTEL_EXPORTER_OTLP_ENDPOINT` and the `Authorization` header. Do not commit either credential.
2. Open **Observability > Frontend**, create `dear-diary-web-staging`, and allow exactly
   `https://staging.d33b4rjnv35mrn.amplifyapp.com` and `https://localhost` (Android WebView). Grafana
   Cloud accepts only HTTP(S) origins, so the default iOS `capacitor://localhost` origin requires a
   separately authenticated HTTPS telemetry proxy before it can be enabled. Copy the collector URL.
   Create a separate production application and exact production web origin before production rollout.
3. Store the backend values in AWS Systems Manager Parameter Store and the public Faro collector URL in
   the Amplify branch configuration:

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts/configure-grafana-cloud.ps1
   ```

   The script prompts securely for the authorization value, writes
   `/dear-diary/staging/grafana-otlp-endpoint` and
   `/dear-diary/staging/grafana-otlp-authorization` as `SecureString` parameters, preserves the existing
   Amplify branch variables, and adds `VITE_GRAFANA_FARO_URL`.

4. Confirm `DearDiaryEcsTaskExecutionRole` can call `ssm:GetParameters` and `kms:Decrypt` for those two
   parameters. The task definition injects them only at runtime.
5. Import all six JSON dashboards from `ops/grafana/dashboards`. Choose the requested Grafana Cloud
   Metrics, Logs, and Traces data sources during import. **Release Health** and **Integrity Health**
   intentionally combine backend Prometheus metrics with privacy-safe Faro measurements stored in
   Loki; Grafana stores Faro custom measurements as logs rather than Prometheus series.
6. Import `ops/prometheus/alerts.yml` into Grafana Cloud Metrics alerting for backend integrity,
   availability, latency, authentication, database, and object-storage alerts. In **Frontend
   Observability > Alerts**, enable the managed frontend error alerts and create Grafana-managed Loki
   alerts from the three client integrity queries in **Integrity Health**. Client Faro measurements
   are Loki records, so a Prometheus-only rule cannot alert on them. Select a notification contact
   point and run a synthetic staging failure before enabling paging.
7. In **Connections > AWS**, connect AWS account `908027418886` in `ap-south-1` and enable ECS,
   Application/Network Load Balancer, S3, RDS/PostgreSQL, and CloudWatch Logs integrations. This adds
   infrastructure and AWS service health to the same Grafana stack.

The AWS IDs in this repository are deployment identifiers, not credentials. Access policy tokens,
notification destinations, and Grafana service-account tokens always stay in Grafana or AWS secret
storage.

## Deploy and verify

Redeploy both staging components after the one-time setup. The ECS task enables OTLP logs, metrics, and
10% sampled traces; the Amplify build embeds only the CORS-restricted Faro collector URL.

Verify the data path in this order:

1. In Grafana Explore (Metrics), query
   `process_uptime_seconds{application="dear-diary-sync-api",environment="staging"}`.
2. Send a safe correlation ID to staging and find it in Explore (Logs):

   ```powershell
   Invoke-WebRequest `
     https://de-95a19ada9bcf4598832bc6673d977727.ecs.ap-south-1.on.aws/actuator/health `
     -Headers @{ 'X-Correlation-Id' = 'grafana-cloud-smoke-1234' }
   ```

   Query `{service_name="dear-diary-sync-api"} |= "grafana-cloud-smoke-1234"` and open the trace ID.

3. In Explore (Traces), query `{ resource.service.name = "dear-diary-sync-api" }`.
4. Open **Observability > Frontend**, load the staging web app, perform a sync, and confirm the
   `dear-diary-client` application receives a new session and measurement.
5. Open **Infrastructure > AWS > ECS** and confirm the staging service and task appear.

The checked-in dashboards divide investigation by question:

- **Observability Overview**: Is the API publishing metrics, logs, and traces?
- **Logs & Errors**: What happened for a status, route, severity, correlation ID, or slow request?
- **Sync Health**: Are commits successful, timely, and keeping cursors and notifications current?
- **Integrity Health**: Did either the API or client detect hash, sequence, invariant, decryption, or
  corruption failures?
- **Dependency Health**: Are PostgreSQL and encrypted object storage healthy?
- **Release Health**: Did backend and frontend telemetry remain healthy after a release?

Treat `No data` differently from zero. Traffic-derived latency and success-rate panels can correctly
show `No data` before staging traffic exists. Safety counters use explicit zero fallbacks so a healthy
quiet system displays `0`. Uptime and continuously published gauges should never remain `No data` after
two OTLP export intervals; investigate the metrics endpoint, token scopes, and dashboard data-source
selection if they do.

If the backend task will not start, check that both SSM parameters exist and that the ECS execution role
can decrypt them. A healthy task with no signals usually means an endpoint/header was copied partially;
copy both values again from the OpenTelemetry connection tile. Faro `401`/`403` responses normally mean
the collector URL or exact allowed origin is wrong.

## Service objectives

| Concern                  | Initial objective                                      | Alerting approach                    |
| ------------------------ | ------------------------------------------------------ | ------------------------------------ |
| Sync commit availability | 99.9% successful commits over 30 days                  | Multi-window burn-rate page          |
| Sync commit latency      | 99% under 2 seconds                                    | Ticket on sustained p95 regression   |
| Integrity                | Zero hash, sequence, invariant, or corruption failures | Page immediately                     |
| Notification freshness   | 99% published within 15 minutes                        | Warn on age/depth, page if sustained |
| Client stability         | At least 99.8% crash-free sessions                     | Release/version scoped warning       |

Treat the checked-in rules as a starting point. Tune them from measured staging baselines and verify
every notification includes a dashboard link, owner, severity, and runbook before paging is enabled.
