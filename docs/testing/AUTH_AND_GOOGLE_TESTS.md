# Auth And Google Tests

## Automated

- Local PIN creation, supported PIN validation, correct/incorrect PIN handling, recovery question normalization, recovery answer checks, and Google recovery binding are covered by `src/domain/security.test.ts`.
- Web companion launch renders the Google sign-in entry point in Playwright.
- Supabase Auth exchange and refresh behavior are covered by `src/sync/supabaseAuth.test.ts`.
- Google profile import behavior is covered by `src/utils/googleProfile.test.ts`.

## Not Executed In This Environment

Real Google OAuth and Drive authorization were not executed because they require a user consent flow and must not be simulated as passed. No user secrets, OAuth tokens, refresh tokens, PINs, recovery passphrases, client secrets, service-role keys, or private keys were requested or logged.

## Required Manual Checks

1. Native Google sign-in on Android.
2. Web Google sign-in for companion pairing.
3. Google Drive `appDataFolder` grant.
4. Session expiration and reauthorization.
5. Wrong Google account handling.
6. Sign-out clears sensitive UI/session state.
7. Recovery passphrase entry directly inside the app.
8. Biometric success, cancel, and failure on a real device.
