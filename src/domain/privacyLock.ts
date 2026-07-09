export const DEFAULT_NATIVE_BACKGROUND_PRIVACY_LOCK_MS = 5 * 60 * 1000;

export const shouldLockAfterBackground = ({
  backgroundedAt,
  resumedAt,
  privacyIntervalMs = DEFAULT_NATIVE_BACKGROUND_PRIVACY_LOCK_MS,
}: {
  backgroundedAt: number | null;
  resumedAt: number;
  privacyIntervalMs?: number;
}): boolean => {
  if (backgroundedAt === null) return false;
  return resumedAt - backgroundedAt >= privacyIntervalMs;
};
