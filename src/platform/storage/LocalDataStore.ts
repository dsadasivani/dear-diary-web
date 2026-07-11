import type { Entry, Note } from '../../types';

export interface LocalQueryPageOptions {
  limit?: number;
  cursor?: string;
  offset?: number;
}

export interface LocalQueryPageResult<T> {
  items: T[];
  nextCursor?: string;
  total?: number;
}

export interface LocalEntryQueryOptions extends LocalQueryPageOptions {
  diaryId?: string;
  yearMonth?: string;
  sort?: 'date-desc' | 'date-asc' | 'updated-desc' | 'created-desc';
  allowedDiaryIds?: string[];
  excludeDiaryIds?: string[];
  fromDate?: string;
  toDate?: string;
  mood?: string;
  hasPhotos?: boolean;
}

export interface LocalNoteQueryOptions extends LocalQueryPageOptions {
  filter?: 'all' | 'pinned' | 'tagged' | 'untagged';
  sort?: 'pinned-updated-desc' | 'updated-desc';
  fromDate?: string;
  toDate?: string;
}

export interface LocalDataStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  setItems(items: Record<string, string>): Promise<void>;
  removeItem(key: string): Promise<void>;
  clear(): Promise<void>;
  getStructuredCollection?<T>(key: string): Promise<T[] | undefined>;
  getStructuredRecord?<T>(key: string, id: string): Promise<T | null | undefined>;
  queryEntries?(options: LocalEntryQueryOptions): Promise<LocalQueryPageResult<Entry> | undefined>;
  queryNotes?(options: LocalNoteQueryOptions): Promise<LocalQueryPageResult<Note> | undefined>;
}
