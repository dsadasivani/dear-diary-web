# Loredays rebrand compatibility inventory

This inventory records the boundary between the Loredays brand layer and legacy technical contracts that must remain stable for existing installations.

## Rebranded surfaces

- Product shell, bootstrap, lock/setup, web companion, settings, notifications, biometric prompts, error copy, and accessibility labels.
- Browser title, description, Open Graph/X metadata, favicon, Apple touch icon, Capacitor display name, and Android display labels.
- Home, entry, memory, search, note conversion, and multi-collection copy.
- Existing book-and-feather mark retained across the web favicon, app shell, splash artwork, and Android adaptive/legacy launcher assets.
- Public README introductions, product-facing technical documentation, and operator-facing dashboard titles.

## Stable identifiers intentionally retained

The following are compatibility contracts, not brand copy. Renaming them would risk sessions, local content, encrypted data, deep links, sync state, deployed resources, or monitoring continuity.

- npm package and release flags: `dear-diary-web`, `DEAR_DIARY_RELEASE_BUILD`, and `VITE_DEAR_DIARY_E2E`.
- Native identity: `com.deardiary.app`, Java package `com.deardiary.app`, legacy URL schemes `deardiary:` and `com.deardiary.app:`, and existing `deardiary.app` HTTPS deep-link hosts.
- Native encryption: the `dear-diary-sqlite` iOS keychain prefix.
- Local persistence: `deardiary_*` local/session preference keys, `dear_diary_secure_v1` IndexedDB, `dear_diary_local` SQLite, the `deardiary_` secure-storage prefix, structured collection names, and sync cache/outbox keys.
- Client events and diagnostics: existing `deardiary-*`/`dear-diary:*` browser and Capacitor event names, telemetry namespaces, Grafana UIDs, and metric names.
- Backend compatibility: Java package `com.deardiary.sync`, the `DearDiarySyncApiApplication` bootstrap class, Gradle group, local database credentials/names, API contracts, and database migrations.
- Deployed infrastructure: existing AWS ECR/ECS/IAM/SSM/S3/log-group names, GitHub workflow resource names, Docker container/volume/bucket names, and observability service names.

## Data migration decision

No data migration is required. The rebrand changes display metadata, copy, and replaceable assets only. Existing storage keys, databases, encryption material, authentication identity, sync protocols, media paths, API contracts, and deep links continue to resolve exactly as before.

## Asset status

Loredays intentionally retains the established warm-gold book-and-feather mark on charcoal. The original icon, splash artwork, and generated Android asset family remain unchanged; the web brand component references a copy of that same source icon through `BRAND_ASSETS`.
