# UI architecture

## Boundaries

`AppBootstrap` owns startup, migrations, and designed recovery states. `App` coordinates authentication, shell data, global overlays, and navigation. Feature screens own view state. Repository interfaces own persistence, search, aggregation, security, sync, and backup operations.

`src/repositories/capabilities.ts` exposes narrower reader/writer capability contracts over the current repository implementation. Feature extraction should depend on the smallest useful contract. This permits gradual decomposition without duplicating storage or sync logic.

Navigation is modelled in `src/navigation/appNavigation.ts` as a discriminated target union. `resolveNavigationTarget` produces one complete, valid screen state and clears unrelated resource IDs. The positional `handleNavigate` callback in `App` is a compatibility boundary for existing screens; new code constructs typed targets directly.

## Feature map

- Today: composition and ambient context, with repository-fed recent memories.
- Journals and reader: object browsing, security gating, entry timeline, and shared cover identity.
- Editor: local composition, selection-safe rich-text commands, one persistence path, explicit local/sync status.
- Notes and Search: lightweight capture and repository-backed retrieval.
- Insights: repository-backed aggregation over locally available partitions.
- Settings: profile, security, sync/backup, appearance, and customization sections.

## Data and time rules

User-facing calendar dates use `src/utils/localDate.ts`; do not derive them by slicing UTC ISO strings. UTC remains appropriate for sync timestamps, ordering metadata, and month partition protocol keys where explicitly documented.

External content is sanitized before persistence/rendering. Secrets stay in secure storage abstractions. UI components do not access IndexedDB, SQLite, Supabase, or Drive directly.

## Incremental extraction order

When a large screen changes, first extract pure rules, then repository capability use, then focused UI components/hooks. Keep persistence paths singular and add contract tests before moving orchestration. Avoid a parallel application rewrite.
