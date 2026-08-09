# Sync V2 and account identity

Loredays uses Google only to establish a stable user identity and to authenticate with Supabase. It does not request Google Drive access or store encrypted collection objects in Drive.

Sync V2 stores only encrypted operation, media, snapshot, recovery, and device-key packages in the configured object store. The Spring sync API owns account authorization, device registration, cursors, conflict-safe operation commits, pairing, primary recovery, key rotation, and revocation.

The Android phone is the primary device. Browser companions are approved with an encrypted key package. Removing a companion from the primary rotates the account key. A browser may unlink itself with a device-private-key signature; the server revokes only that matching companion and the browser destroys its local cache and keys.

Recovery passphrases wrap account keys client-side. The active primary also retains its validated passphrase in platform secure storage so companion removal does not prompt for it. That credential is never included in synchronization or portable exports. Existing primaries must complete the one-time security upgrade before device removal is enabled.
