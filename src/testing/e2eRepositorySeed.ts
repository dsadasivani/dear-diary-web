import { diaryRepository } from '../repositories';

const shouldSeed = (): boolean => {
  if (import.meta.env.VITE_DEAR_DIARY_E2E !== '1' || typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).has('e2eApp');
};

export const seedE2eRepositoryIfRequested = async (): Promise<void> => {
  if (!shouldSeed()) return;
  if (!(await diaryRepository.getLocalSyncAccountState())) {
    await diaryRepository.saveLocalSyncAccountState({
      accountId: 'e2e-account',
      deviceId: 'e2e-device',
      deviceRole: 'primary_mobile',
      googleUserId: 'e2e-google-user',
      googleEmail: 'e2e@example.test',
      devicePublicKey: 'e2e-public-key',
      recoveryKeyDriveFileId: 'e2e-recovery-key',
      latestSnapshotDriveFileId: 'e2e-snapshot',
      currentSyncSequence: 0,
      keyEpoch: 1,
      linkedAt: 1,
    });
  }
  const diaries = await diaryRepository.listDiaries();
  const openDiary =
    diaries.find((diary) => diary.name === 'E2E Open Diary') ||
    (await diaryRepository.createDiary({
      name: 'E2E Open Diary',
      emoji: 'O',
      color: '#4C6A58',
      isLocked: false,
    }));
  const lockedDiary =
    diaries.find((diary) => diary.name === 'E2E Locked Diary') ||
    (await diaryRepository.createDiary({
      name: 'E2E Locked Diary',
      emoji: 'L',
      color: '#8A3D55',
      isLocked: true,
    }));
  const entries = await diaryRepository.listEntries();
  if (!entries.some((entry) => entry.title === 'E2E Public Picnic'))
    await diaryRepository.createEntry({
      diaryId: openDiary.id,
      date: '2026-07-10',
      title: 'E2E Public Picnic',
      body: '<p>ordinary visible memory</p>',
      moodName: 'Calm',
      moodEmoji: '',
      tags: ['shared'],
      photoUris: [],
    });
  if (!entries.some((entry) => entry.title === 'E2E Private Keyword'))
    await diaryRepository.createEntry({
      diaryId: lockedDiary.id,
      date: '2026-07-11',
      title: 'E2E Private Keyword',
      body: '<p>secret locked diary body</p>',
      moodName: 'Calm',
      moodEmoji: '',
      tags: ['private'],
      photoUris: [],
    });
  if (!entries.some((entry) => entry.title === 'E2E Sanitizer Probe'))
    await diaryRepository.createEntry({
      diaryId: openDiary.id,
      date: '2026-07-09',
      title: 'E2E Sanitizer Probe',
      body: '<p>sanitized visible marker</p><img src=x onerror="window.__e2eXss=1"><script>window.__e2eXss=1</script>',
      moodName: 'Calm',
      moodEmoji: '',
      tags: ['shared'],
      photoUris: [],
    });
  const notes = await diaryRepository.listNotes();
  if (!notes.some((note) => note.title === 'E2E Quick Note'))
    await diaryRepository.createNote({
      title: 'E2E Quick Note',
      body: '<p>plain quick note</p>',
      isPinned: true,
      tags: ['shared'],
    });
  if (!notes.some((note) => note.title === 'E2E Sanitized Note'))
    await diaryRepository.createNote({
      title: 'E2E Sanitized Note',
      body: '<p>safe note marker</p><object data="javascript:alert(1)">bad</object>',
      isPinned: false,
      tags: ['shared'],
    });
  if (
    (await diaryRepository.getPartitionHydrationState('month:2021-03')).status === 'not_available'
  ) {
    await diaryRepository.markPartitionAvailable('month:2021-03', 4);
  }
};
