# Auth And Google Tests

## Automated

- Local PIN creation, supported PIN validation, correct/incorrect PIN handling, recovery question normalization, recovery answer checks, and Google recovery binding are covered by `src/domain/security.test.ts`.
- Web companion launch renders the Google sign-in entry point in Playwright.
- Supabase Auth exchange and refresh behavior are covered by `src/sync/supabaseAuth.test.ts`.
- Google profile import behavior is covered by `src/utils/googleProfile.test.ts`.

## Latest Manual Evidence

On 2026-07-12, the MD-021 primary recovery rerun used a disposable real Google account in the app without logging tokens, passphrases, private keys, or OAuth secrets. The server-finalized recovery checkpoint resumed successfully on emulator, and the non-secret Supabase verification query passed all 16 summary checks for account, active primary, cursor, recovery, key rotation, key-package, and revocation state.

## Not Executed In This Environment

Full real Google OAuth and Drive authorization breadth was not executed because it requires user consent and provider state and must not be simulated as passed. The completed MD-021 recovery sign-in is useful evidence for that flow only; it does not cover token refresh, Drive object upload/download discovery, wrong-account handling, or real cloud outbox resume. No user secrets, OAuth tokens, refresh tokens, PINs, recovery passphrases, client secrets, service-role keys, or private keys were requested or logged.

## Required Manual Checks

1. Native Google sign-in on Android beyond the completed MD-021 recovery path.
2. Web Google sign-in for companion pairing.
3. Google Drive `appDataFolder` grant.
4. Session expiration and reauthorization.
5. Wrong Google account handling.
6. Sign-out clears sensitive UI/session state.
7. Recovery passphrase entry directly inside the app.
8. Biometric success, cancel, and failure on a real device.
