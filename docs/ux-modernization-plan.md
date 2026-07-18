# Dear Diary UX modernization plan

## Existing-product audit

- **Navigation and routes:** `App.tsx` owns state-based navigation for Today/Home, Journals, Notes, Search, Insights/Stats, Settings, journal reader/settings, and the entry editor. Native deep links resolve into the same state machine. The compact shell currently exposes six bottom-bar actions; the large shell duplicates Search and Settings in its sidebar.
- **Screens:** the product UI is concentrated in `HomeScreen`, `DiariesScreen`, `DiaryDetailScreen`, `DiarySettingsScreen`, `EntryEditorScreen`, `NotesScreen`, `SearchScreen`, `StatsScreen`, `AppSettingsScreen`, and `LockScreen`. Several screens already have separate mobile and desktop render branches.
- **Shared UI:** `ProfileAvatar`, `OverlayPortal`, `RichTextEditor`, `SanitizedRichText`, `SyncedImage`, `AudioWaveformPlayer`, and passphrase/sync panels are reused. Shell, navigation, buttons, sheets, status messages, and empty/loading states are mostly local implementations and need consolidation.
- **Responsive behavior:** `useIsDesktop` currently changes directly from mobile to desktop at 1024px. Screens mix `lg`, `xl`, and `2xl` breakpoints, leaving no intentional tablet shell. The modernization uses compact `<768px`, medium `768–1199px`, and large `>=1200px`.
- **Native behavior:** Capacitor integrations cover app lifecycle locking, Android back handling, deep links, secure storage/SQLite, biometrics, camera/filesystem media, voice/speech, notifications, Google sign-in, status bar, and haptics. UI work must retain these handlers and services.
- **Sensitive actions:** PIN setup/reset, biometric access, per-journal locks, recovery question/passphrase, account connection, conflict recovery, archive restore, journal/entry/note deletion, and data reset require explicit, accessible confirmation and plain-language status.
- **Testing:** component tests cover lock, passphrase, synced images, and reader navigation. Playwright covers onboarding, keyboard navigation, offline/lock behavior, search privacy, note CRUD, entry CRUD, sanitization, and axe checks. Existing test IDs are treated as compatibility contracts.
- **Terminology:** user-facing copy mixes Home/Today, Diary/Journal, Stats/Reflections/Insights, Quick Thought/Note, and Cloud/Drive/Sync. Primary UI will use Today, Journal, Entry, Note, Insights, Memory, and Sync & Backup.

## Implementation phases

### Progress

- Completed: responsive shell, navigation hierarchy, shared shell and control primitives, semantic tokens, Today/Journals/Notes/reader simplification, and terminology alignment.
- Completed: seven-step private setup, explicit Ready state, separated recovery and encrypted-account stages, and opt-in ambient lock screen preference.
- Completed: editor autosave for new and existing entries, visible save status, browser unload protection, protected in-app exit/discard choices, progressive Entry details, and desktop photo drag-and-drop.
- Completed: focused-flow navigation suppression and native-back handling for journal/note creation, resizable and collapsible desktop Notes, responsive journal-settings navigation with typed deletion, Search geometry continuity, and the narrative Insights replacement.
- Completed: TypeScript, component, storage, server, production-build, browser E2E/accessibility, Android unit, and Android lint validation. Physical-device/provider and production-signing checks remain release activities requiring release hardware and credentials.

1. **Foundation and shell**
   - Add responsive-layout primitives and shared buttons, icon buttons, cards, status/empty states, bottom sheet, create sheet, compact navigation, medium navigation rail, and large sidebar/top bar.
   - Consolidate typography, radius, shadow, target-size, focus, safe-area, and reduced-motion tokens.
   - Move Search to headers/top search; move Settings and Lock to the profile menu/sidebar footer; retain compatibility test IDs on their new controls.
2. **Core journaling**
   - Reorder Today around continue writing, prompt, recent journals, and compact progress.
   - Make Journals list-first with search/sort/filter/view controls and staged creation.
   - Clarify reader navigation and metadata; prioritize writing and progressively disclose editor tools; simplify journal settings and destructive actions.
3. **Supporting content**
   - Give Notes a predictable compact list/editor flow, Search a single consistent field and accessible filters, and rename/qualify Insights visualizations.
4. **Trust and settings**
   - Separate unlock/setup/recovery concepts, clarify the security mental model, organize settings by Profile, Appearance, Writing, Privacy & Security, Sync & Backup, Data & Storage, and About.
5. **Validation**
   - Verify empty/loading/error/offline states, dark theme, keyboard/focus behavior, reduced motion, compact/medium/large viewports, component tests, Playwright/axe, TypeScript, and production build.

## Migration risks

- State-based navigation and native back/deep-link behavior can regress if route semantics change; retain existing tab/screen identifiers internally.
- Large screen components contain business logic alongside UI; refactor presentation incrementally without moving repository, encryption, or sync logic.
- Existing e2e selectors refer to legacy navigation IDs; preserve them on the equivalent new entry points.
- Long settings/editor screens have many native and security branches; prioritize shared patterns and wording while keeping each underlying operation intact.
