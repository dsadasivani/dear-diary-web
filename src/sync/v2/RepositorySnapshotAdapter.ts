import type { RepositorySnapshot } from '../../repositories/DiaryRepository';
import type { SyncRecordType } from '../../types';
import type { SyncV2CanonicalSnapshotState } from './snapshot/PersistentSyncV2SnapshotStore';

const legacyRecordTypeByV2Name: Readonly<Record<string, SyncRecordType>> = {
  DIARY: 'diary',
  ENTRY: 'entry',
  NOTE: 'note',
  SETTINGS: 'settings',
  PROFILE: 'profile',
};

export const repositorySnapshotToV2State = (
  snapshot: RepositorySnapshot,
): SyncV2CanonicalSnapshotState => {
  const records: Record<string, unknown> = {};
  snapshot.diaries.forEach((value) => {
    records[`DIARY:${value.id}`] = value;
  });
  snapshot.entries.forEach((value) => {
    records[`ENTRY:${value.id}`] = value;
  });
  snapshot.notes.forEach((value) => {
    records[`NOTE:${value.id}`] = value;
  });
  if (snapshot.settings) records['SETTINGS:settings'] = snapshot.settings;
  if (snapshot.userProfile) records['PROFILE:profile'] = snapshot.userProfile;
  if (snapshot.security) records['SECURITY:security'] = snapshot.security;
  return {
    records,
    recordVersions: Object.fromEntries(Object.keys(records).map((key) => [key, 0])),
    mediaPointers: {},
  };
};

export const repositorySnapshotFromV2State = (
  state: SyncV2CanonicalSnapshotState,
): RepositorySnapshot => ({
  diaries: Object.entries(state.records)
    .filter(([key]) => key.startsWith('DIARY:'))
    .map(([, value]) => value as RepositorySnapshot['diaries'][number]),
  entries: Object.entries(state.records)
    .filter(([key]) => key.startsWith('ENTRY:'))
    .map(([, value]) => value as RepositorySnapshot['entries'][number]),
  notes: Object.entries(state.records)
    .filter(([key]) => key.startsWith('NOTE:'))
    .map(([, value]) => value as RepositorySnapshot['notes'][number]),
  settings: state.records['SETTINGS:settings'] as RepositorySnapshot['settings'],
  userProfile: state.records['PROFILE:profile'] as RepositorySnapshot['userProfile'],
  security: state.records['SECURITY:security'] as RepositorySnapshot['security'],
  syncRecordVersions: Object.fromEntries(
    Object.entries(state.recordVersions).flatMap(([key, version]) => {
      const separator = key.indexOf(':');
      if (separator <= 0) return [];
      const legacyRecordType = legacyRecordTypeByV2Name[key.slice(0, separator)];
      if (!legacyRecordType) return [];
      return [[`${legacyRecordType}${key.slice(separator)}`, version] as const];
    }),
  ),
});
