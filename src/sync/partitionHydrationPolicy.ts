export interface ArchiveHydrationPolicyInput {
  isOnline: boolean;
  isWifi: boolean;
  isCharging: boolean;
  batteryLevel?: number;
  userAllowedMobileData?: boolean;
  storagePressure?: 'low' | 'normal' | 'high';
}

export interface ArchiveHydrationDecision {
  allowed: boolean;
  reason: 'allowed' | 'offline' | 'mobile_data_blocked' | 'battery_saver' | 'storage_pressure' | 'disabled_by_runtime_flag';
}

export const shouldBackgroundHydrateArchive = ({
  isOnline,
  isWifi,
  isCharging,
  batteryLevel = 1,
  userAllowedMobileData = false,
  storagePressure = 'normal',
}: ArchiveHydrationPolicyInput): ArchiveHydrationDecision => {
  if (!isOnline) return { allowed: false, reason: 'offline' };
  if (storagePressure === 'high') return { allowed: false, reason: 'storage_pressure' };
  if (!isWifi && !userAllowedMobileData) return { allowed: false, reason: 'mobile_data_blocked' };
  if (!isCharging && batteryLevel < 0.35) return { allowed: false, reason: 'battery_saver' };
  return { allowed: true, reason: 'allowed' };
};
