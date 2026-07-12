const SUPPORTED_SCHEMES = new Set(['deardiary:', 'com.deardiary.app:']);
const SUPPORTED_HTTPS_HOSTS = new Set(['deardiary.app', 'www.deardiary.app']);

export type DearDiaryDeepLinkTarget =
  | { kind: 'home' }
  | { kind: 'diaries' }
  | { kind: 'diary'; diaryId: string; entryId?: string }
  | { kind: 'entry'; entryId: string; diaryId?: string }
  | { kind: 'notes'; noteId?: string }
  | { kind: 'search'; query?: string }
  | { kind: 'stats' }
  | { kind: 'settings' };

const cleanSegment = (value: string | undefined): string => {
  if (!value) return '';
  try {
    return decodeURIComponent(value).trim();
  } catch {
    return '';
  }
};

const normalizeSegments = (url: URL): string[] => {
  const segments = [
    ...(SUPPORTED_SCHEMES.has(url.protocol) && url.hostname ? [url.hostname] : []),
    ...url.pathname.split('/'),
  ];
  return segments.map(cleanSegment).filter(Boolean);
};

const optionalParam = (url: URL, ...names: string[]): string | undefined => {
  for (const name of names) {
    const value = cleanSegment(url.searchParams.get(name) || undefined);
    if (value) return value;
  }
  return undefined;
};

export const parseDearDiaryDeepLink = (rawUrl: string): DearDiaryDeepLinkTarget | null => {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const isCustomScheme = SUPPORTED_SCHEMES.has(url.protocol);
  const isSupportedHttps = url.protocol === 'https:' && SUPPORTED_HTTPS_HOSTS.has(url.hostname);
  if (!isCustomScheme && !isSupportedHttps) return null;

  const segments = normalizeSegments(url);
  const [area, firstId, subArea, secondId] = segments;
  if (!area) return { kind: 'home' };

  switch (area.toLowerCase()) {
    case 'home':
      return { kind: 'home' };
    case 'diaries':
    case 'diary': {
      if (!firstId) return { kind: 'diaries' };
      const entryId = subArea?.toLowerCase() === 'entries' || subArea?.toLowerCase() === 'entry'
        ? cleanSegment(secondId)
        : optionalParam(url, 'entryId', 'entry');
      return entryId
        ? { kind: 'diary', diaryId: firstId, entryId }
        : { kind: 'diary', diaryId: firstId };
    }
    case 'entries':
    case 'entry': {
      if (!firstId) return null;
      const diaryId = optionalParam(url, 'diaryId', 'diary');
      return diaryId ? { kind: 'entry', entryId: firstId, diaryId } : { kind: 'entry', entryId: firstId };
    }
    case 'notes':
    case 'note':
      return firstId ? { kind: 'notes', noteId: firstId } : { kind: 'notes' };
    case 'search': {
      const query = optionalParam(url, 'q', 'query');
      return query ? { kind: 'search', query } : { kind: 'search' };
    }
    case 'stats':
    case 'reflections':
      return { kind: 'stats' };
    case 'settings':
    case 'app-settings':
      return { kind: 'settings' };
    default:
      return null;
  }
};
