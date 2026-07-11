import type { Entry, Note } from '../../types';

export type CursorValue = string | number | null;
export type EntrySortKey = 'date-desc' | 'date-asc' | 'updated-desc' | 'created-desc';
export type NoteSortKey = 'pinned-updated-desc' | 'updated-desc';
export type CursorRecordType = 'entry' | 'note';

export interface PageCursorOptions {
  limit?: number;
  cursor?: string;
  offset?: number;
}

export interface KeysetPageCursor {
  kind: 'keyset';
  recordType: CursorRecordType;
  sort: string;
  values: CursorValue[];
}

export interface OffsetPageCursor {
  kind: 'offset';
  offset: number;
}

export type DecodedPageCursor = KeysetPageCursor | OffsetPageCursor;

const KEYSET_CURSOR_PREFIX = 'ks:';
const MAX_PAGE_LIMIT = 200;

const normalizeCursorValue = (value: unknown): CursorValue => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') return value;
  return null;
};

const compareCursorPrimitive = (left: CursorValue, right: CursorValue): number => {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return String(left ?? '').localeCompare(String(right ?? ''));
};

const compareCursorValues = (
  left: CursorValue[],
  right: CursorValue[],
  directions: Array<'asc' | 'desc'>,
): number => {
  for (let index = 0; index < directions.length; index += 1) {
    const base = compareCursorPrimitive(left[index] ?? null, right[index] ?? null);
    if (base !== 0) return directions[index] === 'desc' ? -base : base;
  }
  return 0;
};

export const normalizePageLimit = (limit?: number): number => (
  Math.max(1, Math.min(limit || 50, MAX_PAGE_LIMIT))
);

export const encodeKeysetCursor = (
  recordType: CursorRecordType,
  sort: string,
  values: CursorValue[],
): string => `${KEYSET_CURSOR_PREFIX}${encodeURIComponent(JSON.stringify({
  v: 1,
  recordType,
  sort,
  values: values.map(normalizeCursorValue),
}))}`;

export const decodePageCursor = (
  cursor: string | undefined,
  recordType: CursorRecordType,
  sort: string,
): DecodedPageCursor => {
  if (!cursor) return { kind: 'offset', offset: 0 };
  if (!cursor.startsWith(KEYSET_CURSOR_PREFIX)) {
    return { kind: 'offset', offset: Math.max(0, Number(cursor) || 0) };
  }

  try {
    const payload = JSON.parse(decodeURIComponent(cursor.slice(KEYSET_CURSOR_PREFIX.length))) as {
      v?: number;
      recordType?: string;
      sort?: string;
      values?: unknown[];
    };
    if (
      payload.v !== 1 ||
      payload.recordType !== recordType ||
      payload.sort !== sort ||
      !Array.isArray(payload.values)
    ) {
      return { kind: 'offset', offset: 0 };
    }
    return {
      kind: 'keyset',
      recordType,
      sort,
      values: payload.values.map(normalizeCursorValue),
    };
  } catch {
    return { kind: 'offset', offset: 0 };
  }
};

export const entryCursorValues = (
  entry: Pick<Entry, 'id' | 'date' | 'createdAt' | 'updatedAt'>,
  sort: EntrySortKey = 'date-desc',
): CursorValue[] => {
  if (sort === 'date-asc') return [entry.date, entry.createdAt || 0, entry.id];
  if (sort === 'updated-desc') return [entry.updatedAt || 0, entry.id];
  if (sort === 'created-desc') return [entry.createdAt || 0, entry.id];
  return [entry.date, entry.updatedAt || 0, entry.id];
};

export const noteCursorValues = (
  note: Pick<Note, 'id' | 'isPinned' | 'updatedAt'>,
  sort: NoteSortKey = 'pinned-updated-desc',
): CursorValue[] => {
  if (sort === 'updated-desc') return [note.updatedAt || 0, note.id];
  return [note.isPinned ? 1 : 0, note.updatedAt || 0, note.id];
};

export const entrySortDirections = (sort: EntrySortKey = 'date-desc'): Array<'asc' | 'desc'> => {
  if (sort === 'date-asc') return ['asc', 'asc', 'asc'];
  if (sort === 'updated-desc') return ['desc', 'asc'];
  if (sort === 'created-desc') return ['desc', 'asc'];
  return ['desc', 'desc', 'asc'];
};

export const noteSortDirections = (sort: NoteSortKey = 'pinned-updated-desc'): Array<'asc' | 'desc'> => (
  sort === 'updated-desc' ? ['desc', 'asc'] : ['desc', 'desc', 'asc']
);

export const compareEntriesForSort = <T extends Pick<Entry, 'id' | 'date' | 'createdAt' | 'updatedAt'>>(
  left: T,
  right: T,
  sort: EntrySortKey = 'date-desc',
): number => compareCursorValues(entryCursorValues(left, sort), entryCursorValues(right, sort), entrySortDirections(sort));

export const compareNotesForSort = <T extends Pick<Note, 'id' | 'isPinned' | 'updatedAt'>>(
  left: T,
  right: T,
  sort: NoteSortKey = 'pinned-updated-desc',
): number => compareCursorValues(noteCursorValues(left, sort), noteCursorValues(right, sort), noteSortDirections(sort));

const pageSortedRecords = <T>(
  sortedItems: T[],
  options: PageCursorOptions,
  cursor: DecodedPageCursor,
  valuesForItem: (item: T) => CursorValue[],
  directions: Array<'asc' | 'desc'>,
  makeCursor: (item: T) => string,
): { items: T[]; nextCursor?: string; total: number } => {
  const limit = normalizePageLimit(options.limit);
  let start = Math.max(0, options.offset || 0);
  if (cursor.kind === 'offset') {
    start = cursor.offset || start;
  } else {
    const nextIndex = sortedItems.findIndex(item => (
      compareCursorValues(valuesForItem(item), cursor.values, directions) > 0
    ));
    start = nextIndex >= 0 ? nextIndex : sortedItems.length;
  }

  const page = sortedItems.slice(start, start + limit);
  return {
    items: page,
    nextCursor: start + page.length < sortedItems.length && page.length > 0
      ? makeCursor(page[page.length - 1])
      : undefined,
    total: sortedItems.length,
  };
};

export const pageEntries = <T extends Entry>(
  entries: T[],
  options: PageCursorOptions,
  sort: EntrySortKey = 'date-desc',
): { items: T[]; nextCursor?: string; total: number } => {
  const sorted = [...entries].sort((left, right) => compareEntriesForSort(left, right, sort));
  return pageSortedRecords(
    sorted,
    options,
    decodePageCursor(options.cursor, 'entry', sort),
    entry => entryCursorValues(entry, sort),
    entrySortDirections(sort),
    entry => encodeKeysetCursor('entry', sort, entryCursorValues(entry, sort)),
  );
};

export const pageNotes = <T extends Note>(
  notes: T[],
  options: PageCursorOptions,
  sort: NoteSortKey = 'pinned-updated-desc',
): { items: T[]; nextCursor?: string; total: number } => {
  const sorted = [...notes].sort((left, right) => compareNotesForSort(left, right, sort));
  return pageSortedRecords(
    sorted,
    options,
    decodePageCursor(options.cursor, 'note', sort),
    note => noteCursorValues(note, sort),
    noteSortDirections(sort),
    note => encodeKeysetCursor('note', sort, noteCursorValues(note, sort)),
  );
};
