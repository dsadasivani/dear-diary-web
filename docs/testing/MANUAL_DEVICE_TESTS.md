# Manual Device Tests

Use this checklist on a real Android device and, where applicable, an emulator. Do not paste secrets into logs or chat.

| ID | Scenario | Expected outcome | Pass/Fail | Notes |
| --- | --- | --- | --- | --- |
| MD-001 | Fresh Android install | App launches locked, encrypted SQLite initializes, no plaintext database is exposed. |  |  |
| MD-002 | Upgrade from older app version | Preferences and encrypted content migrate without data loss. |  |  |
| MD-003 | Missing SQLite encryption secret | App fails safely without silently falling back to plaintext storage. |  |  |
| MD-004 | Changed SQLite encryption secret | Existing database is not opened as plaintext; user sees safe recovery path. |  |  |
| MD-005 | Process death during local write | On restart, content is either fully committed or unchanged. |  |  |
| MD-006 | PIN unlock | Correct PIN unlocks; incorrect PIN rejects; sensitive state clears on lock. | Partial | On `emulator-5556`, intentionally incomplete PIN entry remained on the PIN screen with no Home navigation. Correct PIN unlock and complete wrong-PIN rejection still need local user action without sharing the PIN. |
| MD-007 | Biometric success/cancel/failure | Success unlocks when enabled; cancel/failure falls back to PIN without leaking content. | Partial | On `emulator-5556`, Settings > Security biometric enable reported no enrolled fingerprint/strong biometric, kept the toggle off, and did not expose lock/PIN/private content. Real biometric success/cancel/failure still need physical-device evidence. |
| MD-008 | Background/resume under 5 minutes | Transient permission dialogs do not lock the app. | Pass | `emulator-5556` was sent to launcher for ~15 seconds and relaunched; app resumed to Home with no PIN/private-access prompt. |
| MD-009 | Background/resume over 5 minutes | App locks and per-diary unlocks clear. | Partial | Debug-accelerated emulator check offset WebView `Date.now` by 301 seconds before native resume; app left Home and showed protected-access ambient lock. Real elapsed-time and physical-device background behavior still need evidence. |
| MD-010 | Camera permission grant/denial | Grant attaches photo; denial leaves entry stable and recoverable. |  |  |
| MD-011 | Photo picker cancellation | No broken media pointer is created. | Partial | On `emulator-5556`, a CDP mouse gesture opened Android `PhotopickerGetContentActivity`; Android Back canceled it, and no image/remove-photo controls were present afterward. |
| MD-012 | Microphone denial | Recording fails safely and entry remains editable. | Partial | With Android `RECORD_AUDIO` app-op denied, tapping Voice Note left the editor open with no lock/PIN/startup error and no recording overlay. A visible denial message was not captured, so physical/runtime-prompt evidence remains. |
| MD-013 | Audio recording interruption | Partial recording is either saved deliberately or discarded clearly. | Partial | Voice recording overlay was canceled, the unsaved recording attachment was removed, and the draft was discarded with no save. This is emulator discard-path evidence, not a true call/background interruption. |
| MD-014 | Speech recognition denial | No crash; user can continue typing. | Partial | With Android `RECORD_AUDIO` app-op denied, Voice Text did not crash or expose protected content, but it opened the recording/dictation overlay. The overlay was canceled and the draft discarded; real denial prompt behavior remains unverified. |
| MD-015 | Notifications denial | Reminder UI reports denial and does not loop prompts. | Partial | With Android `POST_NOTIFICATION` app-op denied, attempting to enable Daily Writing Reminder left the toggle off and did not show a repeated prompt, lock, PIN prompt, or startup error. Visible OS-prompt denial copy still needs physical/runtime evidence. |
| MD-016 | Google sign-in | User completes consent in app; tokens are not logged. |  |  |
| MD-017 | Google Drive authorization | Encrypted recovery/snapshot objects appear in appDataFolder only. |  |  |
| MD-018 | Offline start | App opens local encrypted data and shows sync paused state. | Partial | On `emulator-5556`, airplane-mode offline force-start reached the protected-access lock screen with `navigator.onLine=false`, no startup error, and no Home/private content exposure. A later unlocked airplane-mode toggle kept Home/settings accessible and showed the sync-paused banner. |
| MD-019 | Network transition | Returning online resumes pending outbox operations after backoff. | Partial | After disabling airplane mode, WebView reported `navigator.onLine=true`, the offline banner cleared, and no lock/startup error appeared. Pending-outbox resume was not exercised because no new pending outbox item was created. |
| MD-020 | Force-stop during outbox media upload | Restart resumes or safely retries without duplicate visible content. |  |  |
| MD-021 | Force-stop during primary recovery | Restart resumes local restore, stale-tail replay, finalize cleanup, or safe retry without revoking old primary prematurely. | Partial | Current rerun used `emulator-5554` as the existing primary and `emulator-5556` as the recovering device. It hit `md021:after-server-finalized`, force-stopped/relaunched, returned to Home without crash, and passed Supabase row verification. Other primary-recovery checkpoints still need evidence. |
| MD-022 | Force-stop during key rotation | Restart resumes committed package work, promotes already-finalized rotation, or aborts pre-recovery-package rotation; target is not revoked before finalize. | Pass | Current rerun on `emulator-5554` hit `md022:after-rotation-begun` and `md022:after-server-finalized`, force-stopped, relaunched, returned to Home without crash, and passed Supabase row verification for account epoch/device revocation details. |
| MD-023 | Revoked device restart | Device clears sync secrets/local sync state and requires recovery or pairing. | Partial | After MD-021 recovery, old primary `emulator-5554` was force-stopped/relaunched and did not return to Home; it showed private access/connect-Google recovery entry. Supabase row verification passed; secure-storage verification still recommended. |
| MD-024 | Android back navigation | Back exits/navigates consistently without bypassing locks. | Partial | From the protected-access lock screen on `emulator-5556`, Android Back returned to launcher; relaunch stayed locked with no Home navigation. On 2026-07-12, unlocked Back from a deep-linked note returned to the diaries list, Back from diaries returned Home, and Back from Home returned to launcher. Physical-device paths still need evidence. |
| MD-025 | Keyboard resizing | Editor remains usable and controls are not obscured. | Partial | On `emulator-5556`, a new-entry title input and lower body editor both focused with Gboard shown. The focused body editor remained within the visual viewport and the app stayed usable. Physical-device evidence still recommended. |
| MD-026 | Status-bar theme | Light/dark status bar updates with app theme. | Partial | On `emulator-5556`, Settings theme buttons toggled DOM theme and Capacitor `StatusBar.getInfo().style` between `LIGHT` and `DARK`. Android 15+ does not support status-bar background coloring through Capacitor; screenshot pixels confirmed the top system strip stayed `#FAFAFA` while app content changed to `#131012` in dark mode. |
| MD-027 | Native deep links while locked | External links open Dear Diary without bypassing app lock; resource routing waits for unlock. | Partial | Added custom-scheme Android intent filters and native URL handler. Locked-state `deardiary://search?q=privacy` resolved to `MainActivity` and stayed on protected-access lock with no Home/search content exposed. On 2026-07-12, unlocked emulator routing passed for search, stats, settings, notes, diaries, home, diary, entry with explicit diary, entry with resolved diary, and note targets. Physical-device confirmation still needs evidence. |

## 2026-07-11 MD-021 Rerun Evidence

- Devices: existing primary `emulator-5554`, recovering device `emulator-5556`, package `com.deardiary.app`.
- Build: debug-hook build with `VITE_ENABLE_MD_FLOW_HOOKS=true`, `webContentsDebuggingEnabled=true`, and Capacitor bridge logging off.
- User completed the Google/recovery passphrase flow on `emulator-5556`; no passphrase, token, private key, or OAuth secret was logged.
- `md021:after-server-finalized`: checkpoint hit at `2026-07-11T16:20:36.245Z`; the app was force-stopped and relaunched automatically.
- After relaunch, `emulator-5556` returned to Home, persisted `lastCheckpoint` for `md021:after-server-finalized`, and had `pauseAt` clear.
- A subsequent force-stop/relaunch of `emulator-5556` again returned to Home with `pauseAt` clear, providing emulator-level evidence that the pending recovery journal did not replay recovery on the next app start.
- Logcat scan after relaunch did not show matching fatal exception/error lines for the checkpoint window.
- Supabase row verification passed with non-secret summary output: one account matched, active primary was active, latest recovery was finalized, no pending primary recovery remained, restored sequence matched account sequence `190 / 190`, previous primary was revoked/replaced, active-primary cursor was caught up, and primary-recovery revocation was recorded.
- Remaining MD-021 recovery permutations, including wrong passphrase, damaged cloud objects, stale finalize, local cleanup failure, and key-epoch recovery, still need manual evidence.

## 2026-07-11 MD-008/MD-009 Rerun Evidence

- Device: recovered primary `emulator-5556`, package `com.deardiary.app`.
- Build: debug-hook build with `VITE_ENABLE_MD_FLOW_HOOKS=true`, `webContentsDebuggingEnabled=true`, and Capacitor bridge logging off.
- MD-008: sent app to launcher with `KEYCODE_HOME`, waited ~15 seconds, then relaunched. Result: app resumed to Home; boolean UI probe reported `hasHomeNav=true`, `hasPrivateAccess=false`, `hasUnlockDiary=false`, and `hasPinPrompt=false`.
- MD-009: before native resume, used WebView debugging to offset `Date.now` by 301 seconds, then relaunched and immediately reset the override. Result: app left Home and showed protected-access ambient lock text (`TAP TO UNLOCK`, `PROTECTED ACCESS`); Home navigation was absent.
- Limitations: MD-009 was an accelerated debug-only emulator check of the app's long-background branch, not a real five-minute elapsed-time or physical-device background/resume run.

## 2026-07-11 MD-006 Rerun Evidence

- Device: recovered primary `emulator-5556`, package `com.deardiary.app`, starting from the protected-access lock screen.
- Action: opened PIN entry and submitted an intentionally incomplete `123` PIN to avoid guessing or logging the real PIN.
- Result: app stayed on `Enter Security PIN` with `hasHomeNav=false`, `hasUnlockDiary=true`, and PIN/digit copy still visible. No diary Home content was exposed.
- Limitation: correct PIN unlock and a complete wrong-PIN rejection still require local tester action without sharing the PIN.

## 2026-07-11 MD-022 Rerun Evidence

- Device: `emulator-5554`, package `com.deardiary.app`.
- Build: debug-hook build with `VITE_ENABLE_MD_FLOW_HOOKS=true`, `webContentsDebuggingEnabled=true`, and Capacitor bridge logging off.
- `md022:after-rotation-begun`: checkpoint hit at `2026-07-11T13:22:03.208Z`; app was force-stopped and relaunched; app returned to Home. `pauseAt` survived relaunch and was cleared manually to avoid a repeat pause.
- `md022:after-server-finalized`: checkpoint hit at `2026-07-11T13:24:31.793Z`; app was force-stopped and relaunched; app returned to Home. `lastCheckpoint` persisted and `pauseAt` was clear.
- Logcat scan after relaunch did not show matching fatal exception/error lines for the checkpoint window.
- Supabase row verification passed with non-secret summary output: no pending key rotation remained, `15` finalized rotations existed, current key epoch was `23`, a current-epoch key package existed, and rotation revocation was recorded.

## 2026-07-12 MD-018/MD-019 Rerun Evidence

- Device: recovered primary `emulator-5556`, package `com.deardiary.app`, starting from Android launcher after the app had elapsed back into protected access.
- Action: enabled airplane mode with `adb shell cmd connectivity airplane-mode enable`, force-stopped `com.deardiary.app`, launched it offline, and inspected only boolean WebView state.
- MD-018 result: WebView reached `readyState="complete"` with `navigatorOnline=false`; after a short settle it showed protected-access/tap-to-unlock markers with no PIN prompt, Home navigation, Home write button, startup error, or exposed private content.
- Action: disabled airplane mode with `adb shell cmd connectivity airplane-mode disable` and waited for the WebView transition.
- MD-019 result: WebView reported `navigatorOnline=true`, no offline banner, no startup error, and stayed on protected access.
- Follow-up unlocked action: after the local tester unlocked the recovered primary, toggled airplane mode again without creating or reading diary content.
- MD-018 unlocked result: WebView remained complete with `navigatorOnline=false`, Home navigation and Settings stayed available, the offline banner was present, and no protected-access, PIN prompt, or startup-error marker appeared.
- MD-019 unlocked result: after disabling airplane mode, WebView reported `navigatorOnline=true`, the offline banner disappeared, Home navigation stayed available, and no protected-access, PIN prompt, or startup-error marker appeared.
- Limitations: pending-outbox resume after backoff was not exercised because this run did not create a pending sync item.

## 2026-07-11 MD-023 Rerun Evidence

- Device: old primary `emulator-5554`, package `com.deardiary.app`, after MD-021 recovery promoted `emulator-5556`.
- Build: same debug-hook build with `VITE_ENABLE_MD_FLOW_HOOKS=true`, `webContentsDebuggingEnabled=true`, and Capacitor bridge logging off.
- Action: force-stopped and relaunched `com.deardiary.app` on `emulator-5554`.
- Result: app opened to private access/connect-Google recovery entry instead of Home; boolean UI probe reported `hasHomeNav=false`, `hasPrivateAccess=true`, `hasConnectGoogle=true`, and `hasRecoveryCopy=true`.
- Logcat scan after relaunch did not show matching fatal exception/error lines for the restart window.
- Supabase row verification passed with non-secret summary output: device counts were `total=47, active=1, revoked=46`, at least one revocation existed, and the previous primary was revoked/replaced. If an approved manual method exists, still confirm secure sync credentials were cleared without dumping secret values.

## 2026-07-11 MD-024 Rerun Evidence

- Device: recovered primary `emulator-5556`, package `com.deardiary.app`, starting from the MD-009 protected-access lock screen.
- Action: sent Android Back with `KEYCODE_BACK`.
- Result: current focus moved to the Android launcher. Relaunching `com.deardiary.app` stayed on protected-access ambient lock text (`TAP TO UNLOCK`, `PROTECTED ACCESS`) with `hasHomeNav=false`.
- Limitation: this covers locked-screen back behavior only; unlocked back-stack evidence is recorded in the 2026-07-12 section below.

## 2026-07-11 MD-027 Rerun Evidence

- Device: recovered primary `emulator-5556`, package `com.deardiary.app`, starting from the protected-access lock screen.
- Build: debug-hook build rebuilt/synced after adding Android deep-link intent filters and native URL handling.
- Action: invoked `adb -s emulator-5556 shell am start -W -a android.intent.action.VIEW -d "deardiary://search?q=privacy" com.deardiary.app`.
- Result: Android delivered the intent to `com.deardiary.app/.MainActivity`; WebView probe reported `hasHomeNav=false`, `hasProtectedAccess=true`, `hasTapToUnlock=true`, and `hasSearchSurface=false`. The lock was not bypassed and search content was not exposed.
- Limitations: this covers locked-state intent resolution and privacy only.

## 2026-07-12 MD-024/MD-027 Rerun Evidence

- Device: recovered primary `emulator-5556`, package `com.deardiary.app`, started and unlocked by the local tester.
- Build: same debug-hook build with native deep-link intent filters and WebView debugging enabled; Capacitor bridge logging stayed off.
- MD-027 post-unlock search: invoked `deardiary://search?q=privacy`. Android delivered the intent to `MainActivity`; WebView probe reported `activeNavs=["nav-search"]`, `hasGlobalSearchHeading=true`, search input value `privacy`, and no protected-access/PIN prompt.
- MD-027 post-unlock non-resource targets: invoked `deardiary://stats`, `deardiary://settings`, `deardiary://notes`, `deardiary://diaries`, and `deardiary://home`. Each routed to the expected active nav or screen marker with no protected-access/PIN prompt.
- MD-027 post-unlock resource targets: using read-only Capacitor SQLite queries for IDs only, the recovered primary had one diary, two entries, and three notes. Invoked diary, entry-with-diary, entry-resolved-diary, and note links. Diary/entry links activated `nav-diaries` with diary-detail/entry controls visible; note links activated `nav-notes` with note editor controls visible. No titles, bodies, tags, raw JSON, secrets, PINs, tokens, or passphrases were logged.
- MD-024 unlocked Back: from the deep-linked note editor, Android Back stayed inside `MainActivity` and returned to the diaries list; Back from diaries returned Home; Back from Home moved focus to the Android launcher.
- Limitations: this is emulator evidence, not physical-device evidence.

## 2026-07-12 MD-025/MD-026 Rerun Evidence

- Device: recovered primary `emulator-5556`, package `com.deardiary.app`, started unlocked by the local tester.
- MD-025 action: opened a fresh entry editor from Home, focused `entry-title-input`, then focused the lower `entry-body-editor` contenteditable area by ADB tap. No text was entered or saved.
- MD-025 result: Gboard was shown with `mInputShown=true` and `mIsInputViewShown=true`; WebView served input type changed from title text input to body text input. The lower editor was focused with `visualViewportHeight=864`, `innerHeight=864`, body editor rect `top=415.47`, `bottom=595.47`, and `bodyBottomWithinViewport=true`.
- MD-026 action: navigated to Settings > Customize, toggled Light Mode and Dark Mode using the visible app buttons, sampled Android screenshots, and restored Light Mode afterward.
- MD-026 result: DOM theme toggled (`documentElement.classList.contains('dark')` false -> true -> false). `StatusBar.getInfo().style` toggled `LIGHT` in light mode and `DARK` in dark mode; Android dumpsys showed `LIGHT_STATUS_BARS` present in light mode and absent in dark mode.
- MD-026 limitation: on this Android 15+ emulator, Capacitor documents `StatusBar.backgroundColor` as unavailable. Screenshot sampling confirmed the status-bar strip at `(540,66)` stayed `#FAFAFA` even in dark mode, while app content below the status bar changed to `#131012`.

## 2026-07-12 MD-007/MD-011/MD-012/MD-013/MD-014/MD-015 Rerun Evidence

- Device: recovered primary `emulator-5556`, package `com.deardiary.app`, started unlocked by the local tester.
- MD-007 action/result: opened Settings > Security and attempted to enable biometric unlock. The app reported no enrolled fingerprint/strong biometric, kept the biometric toggle off, and stayed unlocked with no protected-access, PIN prompt, or startup-error marker.
- MD-011 action/result: opened a fresh entry editor and triggered the photo library control with CDP mouse events. Android focused `com.google.android.photopicker/com.android.photopicker.PhotopickerGetContentActivity`; Android Back canceled the picker. After return, no image count or remove-photo controls were present, and the draft was discarded.
- MD-012 action/result: set Android `RECORD_AUDIO` app-op to `deny`, tapped Voice Note, then restored the app-op. The editor stayed open with no recording overlay, protected-access marker, PIN prompt, or startup-error marker. A visible microphone-denial copy was not captured.
- MD-013 action/result: while testing voice controls, a recording overlay/unsaved recording attachment appeared. The overlay was canceled, the unsaved recording attachment was removed, and the draft was discarded without saving text or media.
- MD-014 action/result: with Android `RECORD_AUDIO` app-op denied, tapping Voice Text did not crash or lock the app, but the dictation/recording overlay still opened. The overlay was canceled and the draft discarded. This does not prove the runtime speech-denial prompt path.
- MD-015 action/result: with Android `POST_NOTIFICATION` app-op set to `deny`, attempting to enable Daily Writing Reminder left the toggle off; no repeated prompt, protected-access marker, PIN prompt, or startup-error marker appeared. The app-op was restored to default afterward. A visible denial message was not captured.
