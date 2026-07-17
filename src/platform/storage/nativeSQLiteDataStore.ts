import { CapacitorSQLite, SQLiteConnection, type SQLiteDBConnection } from '@capacitor-community/sqlite';
import { SecureStorage } from '@aparajita/capacitor-secure-storage';
import { Preferences } from '@capacitor/preferences';
import type { Diary, Entry, LocalSyncAccountState, Note, PartitionHydrationState, SyncMediaPointer, SyncOutboxOperation } from '../../types';
import type {
  LocalDataStore,
  LocalEntryProjection,
  LocalEntryQueryOptions,
  LocalNoteProjection,
  LocalNoteQueryOptions,
  LocalQueryPageResult,
  LocalStructuredRecordMutation,
} from './LocalDataStore';
import { measureAsync } from '../../utils/performance';
import type { SyncOutboxOperationV2 } from '../../sync/outbox/SyncOutboxOperationV2';
import {
  decodePageCursor,
  encodeKeysetCursor,
  entryCursorValues,
  noteCursorValues,
  normalizePageLimit,
  type CursorValue,
} from './queryPagination';

const DATABASE_NAME = 'dear_diary_local';
const DATABASE_VERSION = 1;
const STORAGE_SCHEMA_VERSION = 7;
const SECURE_STORAGE_PREFIX = 'deardiary_';
const SQLITE_SECRET_KEY = 'sqlite_encryption_secret_v1';
const MIGRATION_META_KEY = 'legacy_preferences_migrated_at';
const SEARCH_INDEX_META_KEY = 'search_index_version_v1';

const LEGACY_LOCAL_STORAGE_KEYS = [
  'deardiary_diaries',
  'deardiary_entries',
  'deardiary_notes',
  'deardiary_security',
  'deardiary_settings',
  'deardiary_userprofile',
  'deardiary_diary_viewmode',
  'deardiary_drive_backup',
] as const;

const STRUCTURED_COMPATIBILITY_KEYS = [
  'deardiary_diaries',
  'deardiary_entries',
  'deardiary_notes',
  'deardiary_settings',
  'deardiary_userprofile',
  'deardiary_security',
  'deardiary_drive_backup',
  'deardiary_diary_viewmode',
  'deardiary_sync_account',
  'deardiary_sync_record_versions',
  'deardiary_sync_media_pointers',
  'deardiary_sync_partition_hydration',
  'deardiary_sync_outbox',
  'deardiary_sync_outbox_v2',
] as const;

const now = (): number => Date.now();

const generateSecret = (): string => {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
};

const boolToInt = (value: unknown): number => value ? 1 : 0;

const utcStartOfDay = (date: string | undefined): number | undefined => {
  if (!date) return undefined;
  const timestamp = Date.parse(`${date}T00:00:00.000Z`);
  return Number.isFinite(timestamp) ? timestamp : undefined;
};

const utcEndOfDay = (date: string | undefined): number | undefined => {
  const start = utcStartOfDay(date);
  return start === undefined ? undefined : start + 86_400_000 - 1;
};

const safeJsonParse = <T>(value: string): T | null => {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    console.warn('Failed to parse SQLite mirror payload:', error);
    return null;
  }
};

const ftsQueryForText = (query?: string): string | null => {
  const tokens = (query || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  if (tokens.length === 0) return null;
  return tokens.map(token => `${token.replace(/"/g, '""')}*`).join(' ');
};

const jsonTagLikePattern = (tag: string): string => `%${JSON.stringify(tag.toLowerCase())}%`;

export class NativeSQLiteDataStore implements LocalDataStore {
  private sqlite = new SQLiteConnection(CapacitorSQLite);
  private db: SQLiteDBConnection | null = null;
  private initPromise: Promise<SQLiteDBConnection> | null = null;
  private writeTail: Promise<void> = Promise.resolve();

  async getItem(key: string): Promise<string | null> {
    return measureAsync('sqlite.bridge.getItem', async () => {
      const db = await this.ensureInitialized();

      const compatibilityResult = await db.query('SELECT value FROM kv_store WHERE key = ? LIMIT 1;', [key]);
      const compatibilityValue = compatibilityResult.values?.[0]?.value ?? null;
      return this.readStructuredValue(db, key, compatibilityValue);
    }, { key });
  }

  async setItem(key: string, value: string): Promise<void> {
    await this.setItems({ [key]: value });
  }

  async setItems(items: Record<string, string>): Promise<void> {
    await measureAsync('sqlite.bridge.setItems', () => this.enqueueWrite(async () => {
      const db = await this.ensureInitialized();

      await measureAsync('sqlite.transaction.setItems', async () => {
      await db.beginTransaction();
      try {
        await this.writeSerializedItemsInTransaction(db, items, false);
        await db.commitTransaction();
      } catch (error) {
        await db.rollbackTransaction().catch(() => undefined);
        throw error;
      }
      });
    }), { keyCount: Object.keys(items).length });
  }

  async removeItem(key: string): Promise<void> {
    await this.enqueueWrite(async () => {
      const db = await this.ensureInitialized();

      await db.run('DELETE FROM kv_store WHERE key = ?;', [key]);
      await this.clearStructuredTablesForKey(db, key);
    });
  }

  async clear(): Promise<void> {
    await this.enqueueWrite(async () => {
      const db = await this.ensureInitialized();

      await db.execute(`
        DELETE FROM kv_store;
        DELETE FROM diaries;
        DELETE FROM entries;
        DELETE FROM entries_fts;
        DELETE FROM entry_blocks;
        DELETE FROM notes;
        DELETE FROM notes_fts;
        DELETE FROM media_assets;
        DELETE FROM app_settings;
        DELETE FROM user_profile;
        DELETE FROM sync_account;
        DELETE FROM sync_record_versions;
        DELETE FROM sync_media_pointers;
        DELETE FROM sync_partition_hydration;
        DELETE FROM sync_outbox;
        DELETE FROM sync_outbox_v2;
        DELETE FROM storage_meta;
      `);
      await this.setMeta(db, 'storage_schema_version', String(STORAGE_SCHEMA_VERSION));
      await this.setMeta(db, 'storage_backend', 'encrypted_sqlite');
      await this.setMeta(db, MIGRATION_META_KEY, String(now()));
      await this.setMeta(db, 'legacy_preferences_retained', 'false');
    });
  }

  async getStructuredCollection<T>(key: string): Promise<T[] | undefined> {
    return measureAsync('sqlite.structured.collection', async () => {
      const db = await this.ensureInitialized();
      switch (key) {
        case 'deardiary_diaries':
          return this.readStructuredRows<T>(db, key, 'SELECT raw_json FROM diaries ORDER BY rowid;');
        case 'deardiary_entries':
          return this.readStructuredRows<T>(db, key, 'SELECT raw_json FROM entries ORDER BY rowid;');
        case 'deardiary_notes':
          return this.readStructuredRows<T>(db, key, 'SELECT raw_json FROM notes ORDER BY rowid;');
        default:
          return undefined;
      }
    }, { key });
  }

  async getStructuredRecord<T>(key: string, id: string): Promise<T | null | undefined> {
    return measureAsync('sqlite.structured.record', async () => {
      const db = await this.ensureInitialized();
      switch (key) {
        case 'deardiary_diaries':
          return this.readStructuredRecord<T>(db, key, 'diaries', id);
        case 'deardiary_entries':
          return this.readStructuredRecord<T>(db, key, 'entries', id);
        case 'deardiary_notes':
          return this.readStructuredRecord<T>(db, key, 'notes', id);
        default:
          return undefined;
      }
    }, { key });
  }

  async putStructuredRecord<T>(key: string, id: string, value: T): Promise<void> {
    await measureAsync('sqlite.structured.record.put', () => this.enqueueWrite(async () => {
      const db = await this.ensureInitialized();
      await db.beginTransaction();
      try {
        await this.upsertStructuredRecord(db, key, id, value, false);
        await db.commitTransaction();
      } catch (error) {
        await db.rollbackTransaction().catch(() => undefined);
        throw error;
      }
    }), { key });
  }

  async deleteStructuredRecord(key: string, id: string): Promise<void> {
    await measureAsync('sqlite.structured.record.delete', () => this.enqueueWrite(async () => {
      const db = await this.ensureInitialized();
      await db.beginTransaction();
      try {
        await this.deleteStructuredRecordRow(db, key, id, false);
        await db.commitTransaction();
      } catch (error) {
        await db.rollbackTransaction().catch(() => undefined);
        throw error;
      }
    }), { key });
  }

  async commitStructuredRecords(input: {
    records: LocalStructuredRecordMutation[];
    items?: Record<string, string>;
  }): Promise<void> {
    await measureAsync('sqlite.structured.records.commit', () => this.enqueueWrite(async () => {
      const db = await this.ensureInitialized();
      await db.beginTransaction();
      try {
        for (const record of input.records) {
          if (record.value === null) {
            await this.deleteStructuredRecordRow(db, record.key, record.id, false);
          } else {
            await this.upsertStructuredRecord(db, record.key, record.id, record.value, false);
          }
        }
        if (input.items) await this.writeSerializedItemsInTransaction(db, input.items, false);
        await db.commitTransaction();
      } catch (error) {
        await db.rollbackTransaction().catch(() => undefined);
        throw error;
      }
    }), { recordCount: input.records.length, itemCount: Object.keys(input.items || {}).length });
  }

  async commitLocalMutationAndOutbox(input: {
    records: LocalStructuredRecordMutation[];
    items?: Record<string, string>;
    outboxOperation: SyncOutboxOperation;
    outboxV2Operation: SyncOutboxOperationV2;
  }): Promise<void> {
    await measureAsync('sqlite.structured.localMutationAndOutbox', () => this.enqueueWrite(async () => {
      const db = await this.ensureInitialized();
      await db.beginTransaction();
      try {
        for (const record of input.records) {
          if (record.value === null) {
            await this.deleteStructuredRecordRow(db, record.key, record.id, false);
          } else {
            await this.upsertStructuredRecord(db, record.key, record.id, record.value, false);
          }
        }
        if (input.items) await this.writeSerializedItemsInTransaction(db, input.items, false);
        await this.upsertOutboxOperation(db, input.outboxOperation, false);
        await this.upsertOutboxV2Operation(db, input.outboxV2Operation, false);
        await db.commitTransaction();
      } catch (error) {
        await db.rollbackTransaction().catch(() => undefined);
        throw error;
      }
    }), { recordCount: input.records.length });
  }

  async queryEntries(options: LocalEntryQueryOptions): Promise<LocalQueryPageResult<Entry> | undefined> {
    return measureAsync('sqlite.query.entries', async () => {
      const db = await this.ensureInitialized();
      if (!await this.isStructuredCollectionReady(db, 'deardiary_entries', 'entries')) return undefined;

      const sort = options.sort || 'date-desc';
      const { whereClause, params } = this.buildEntryQuery(options);
      const cursor = decodePageCursor(options.cursor, 'entry', sort);
      const keyset = cursor.kind === 'keyset' ? this.entryKeysetClause(sort, cursor.values) : null;
      const queryWhereClause = keyset ? this.combineWhereClauses(whereClause, keyset.clause) : whereClause;
      const queryParams = keyset ? [...params, ...keyset.params] : params;
      const limit = normalizePageLimit(options.limit);
      const offset = cursor.kind === 'offset' ? (cursor.offset || options.offset || 0) : 0;
      const total = await this.countRows(db, 'entries', whereClause, params);
      const result = await db.query(
        `SELECT raw_json FROM entries${queryWhereClause} ORDER BY ${this.entryOrderBy(sort)} LIMIT ?${cursor.kind === 'offset' ? ' OFFSET ?' : ''};`,
        cursor.kind === 'offset'
          ? [...queryParams, limit + 1, offset]
          : [...queryParams, limit + 1],
      );
      return this.entryPageFromRows(result.values || [], total, limit, sort);
    }, { filters: this.redactedQueryMetadata(options) });
  }

  async queryNotes(options: LocalNoteQueryOptions): Promise<LocalQueryPageResult<Note> | undefined> {
    return measureAsync('sqlite.query.notes', async () => {
      const db = await this.ensureInitialized();
      if (!await this.isStructuredCollectionReady(db, 'deardiary_notes', 'notes')) return undefined;

      const sort = options.sort || 'pinned-updated-desc';
      const { whereClause, params } = this.buildNoteQuery(options);
      const cursor = decodePageCursor(options.cursor, 'note', sort);
      const keyset = cursor.kind === 'keyset' ? this.noteKeysetClause(sort, cursor.values) : null;
      const queryWhereClause = keyset ? this.combineWhereClauses(whereClause, keyset.clause) : whereClause;
      const queryParams = keyset ? [...params, ...keyset.params] : params;
      const limit = normalizePageLimit(options.limit);
      const offset = cursor.kind === 'offset' ? (cursor.offset || options.offset || 0) : 0;
      const total = await this.countRows(db, 'notes', whereClause, params);
      const result = await db.query(
        `SELECT raw_json FROM notes${queryWhereClause} ORDER BY ${this.noteOrderBy(sort)} LIMIT ?${cursor.kind === 'offset' ? ' OFFSET ?' : ''};`,
        cursor.kind === 'offset'
          ? [...queryParams, limit + 1, offset]
          : [...queryParams, limit + 1],
      );
      return this.notePageFromRows(result.values || [], total, limit, sort);
    }, { filters: this.redactedQueryMetadata(options) });
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeTail.then(operation, operation);
    this.writeTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async ensureInitialized(): Promise<SQLiteDBConnection> {
    if (this.db) return this.db;
    if (!this.initPromise) {
      this.initPromise = this.initialize();
    }
    this.db = await this.initPromise;
    return this.db;
  }

  private async initialize(): Promise<SQLiteDBConnection> {
    await this.ensureEncryptionSecret();

    const hasConnection = await this.sqlite.isConnection(DATABASE_NAME, false).catch(() => ({ result: false }));
    const db = hasConnection.result
      ? await this.sqlite.retrieveConnection(DATABASE_NAME, false)
      : await this.sqlite.createConnection(DATABASE_NAME, true, 'secret', DATABASE_VERSION, false);

    const isOpen = await db.isDBOpen().catch(() => ({ result: false }));
    if (!isOpen.result) {
      await db.open();
    }
    await db.execute('PRAGMA foreign_keys = ON;');

    await this.createSchema(db);
    await this.migrateLegacyPreferences(db);
    return db;
  }

  private async ensureEncryptionSecret(): Promise<void> {
    await SecureStorage.setKeyPrefix(SECURE_STORAGE_PREFIX);
    let secret = await SecureStorage.getItem(SQLITE_SECRET_KEY);
    if (!secret) {
      secret = generateSecret();
      await SecureStorage.setItem(SQLITE_SECRET_KEY, secret);
    }

    const secretStored = await this.sqlite.isSecretStored().catch(() => ({ result: false }));
    if (!secretStored.result) {
      await this.sqlite.setEncryptionSecret(secret);
    }
  }

  private async createSchema(db: SQLiteDBConnection): Promise<void> {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS kv_store (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS storage_meta (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS diaries (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        emoji TEXT,
        color TEXT,
        is_locked INTEGER NOT NULL DEFAULT 0,
        entry_count INTEGER NOT NULL DEFAULT 0,
        last_updated TEXT,
        cover_image_uri TEXT,
        foil_icons_json TEXT,
        raw_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS entries (
        id TEXT PRIMARY KEY NOT NULL,
        diary_id TEXT NOT NULL,
        date TEXT NOT NULL,
        time TEXT,
        title TEXT NOT NULL,
        body TEXT,
        mood_name TEXT,
        mood_emoji TEXT,
        tags_json TEXT NOT NULL,
        photo_uris_json TEXT NOT NULL,
        photo_count INTEGER NOT NULL DEFAULT 0,
        word_count INTEGER NOT NULL DEFAULT 0,
        audio_uri TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        is_timeline_bifurcated INTEGER NOT NULL DEFAULT 0,
        raw_json TEXT NOT NULL,
        FOREIGN KEY (diary_id) REFERENCES diaries(id) ON DELETE CASCADE ON UPDATE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_entries_diary_date ON entries(diary_id, date);
      CREATE INDEX IF NOT EXISTS idx_entries_updated_at ON entries(updated_at);
      CREATE INDEX IF NOT EXISTS idx_entries_created_at ON entries(created_at);
      CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(date);
      CREATE INDEX IF NOT EXISTS idx_entries_date_keyset ON entries(date, updated_at, id);
      CREATE INDEX IF NOT EXISTS idx_entries_created_keyset ON entries(created_at, id);
      CREATE INDEX IF NOT EXISTS idx_entries_updated_keyset ON entries(updated_at, id);

      CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
        id UNINDEXED,
        title,
        body,
        tags,
        mood
      );

      CREATE TABLE IF NOT EXISTS entry_blocks (
        id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        time TEXT,
        body TEXT,
        audio_uri TEXT,
        raw_json TEXT NOT NULL,
        PRIMARY KEY (entry_id, position),
        FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE ON UPDATE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_entry_blocks_entry ON entry_blocks(entry_id, position);

      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        body TEXT,
        is_pinned INTEGER NOT NULL DEFAULT 0,
        tags_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        raw_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_notes_updated_at ON notes(updated_at);
      CREATE INDEX IF NOT EXISTS idx_notes_pinned_updated ON notes(is_pinned, updated_at);
      CREATE INDEX IF NOT EXISTS idx_notes_updated_keyset ON notes(updated_at, id);
      CREATE INDEX IF NOT EXISTS idx_notes_pinned_updated_keyset ON notes(is_pinned, updated_at, id);

      CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
        id UNINDEXED,
        title,
        body,
        tags
      );

      CREATE TABLE IF NOT EXISTS media_assets (
        id TEXT PRIMARY KEY NOT NULL,
        owner_type TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        field TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        uri TEXT NOT NULL,
        mime_type TEXT,
        byte_size INTEGER,
        created_at INTEGER NOT NULL,
        raw_json TEXT,
        CHECK (owner_type IN ('diary', 'entry', 'note'))
      );

      CREATE INDEX IF NOT EXISTS idx_media_owner ON media_assets(owner_type, owner_id);

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS user_profile (
        id TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sync_account (
        id TEXT PRIMARY KEY NOT NULL,
        account_id TEXT,
        device_id TEXT,
        current_sync_sequence INTEGER NOT NULL DEFAULT 0,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sync_record_versions (
        record_key TEXT PRIMARY KEY NOT NULL,
        record_type TEXT NOT NULL,
        record_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK (record_type IN ('diary', 'entry', 'note', 'settings', 'profile'))
      );

      CREATE INDEX IF NOT EXISTS idx_sync_record_versions_type_id ON sync_record_versions(record_type, record_id);

      CREATE TABLE IF NOT EXISTS sync_media_pointers (
        pointer_key TEXT PRIMARY KEY NOT NULL,
        media_id TEXT NOT NULL,
        sequence INTEGER NOT NULL DEFAULT 0,
        drive_file_id TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        local_uri TEXT,
        key_epoch INTEGER,
        raw_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sync_media_pointers_media_id ON sync_media_pointers(media_id);
      CREATE INDEX IF NOT EXISTS idx_sync_media_pointers_drive_file_id ON sync_media_pointers(drive_file_id);
      CREATE INDEX IF NOT EXISTS idx_sync_media_pointers_sequence ON sync_media_pointers(sequence);

      CREATE TABLE IF NOT EXISTS sync_partition_hydration (
        partition_key TEXT PRIMARY KEY NOT NULL,
        status TEXT NOT NULL,
        last_applied_sequence INTEGER NOT NULL DEFAULT 0,
        next_retry_at INTEGER,
        raw_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sync_partition_status ON sync_partition_hydration(status);

      CREATE TABLE IF NOT EXISTS sync_outbox (
        operation_id TEXT PRIMARY KEY NOT NULL,
        account_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        partition_key TEXT NOT NULL,
        record_type TEXT NOT NULL,
        record_id TEXT NOT NULL,
        state TEXT NOT NULL,
        next_retry_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        raw_json TEXT NOT NULL,
        CHECK (record_type IN ('diary', 'entry', 'note', 'settings', 'profile'))
      );

      CREATE INDEX IF NOT EXISTS idx_sync_outbox_state_retry ON sync_outbox(state, next_retry_at);
      CREATE INDEX IF NOT EXISTS idx_sync_outbox_record ON sync_outbox(record_type, record_id);

      CREATE TABLE IF NOT EXISTS sync_outbox_v2 (
        operation_id TEXT PRIMARY KEY NOT NULL,
        account_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        record_type TEXT NOT NULL,
        record_id TEXT NOT NULL,
        operation_type TEXT NOT NULL,
        base_record_version INTEGER NOT NULL,
        state TEXT NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        lease_owner TEXT,
        lease_expires_at INTEGER,
        dependency_operation_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        raw_json TEXT NOT NULL,
        CHECK (record_type IN ('DIARY', 'ENTRY', 'NOTE', 'SETTINGS', 'PROFILE')),
        CHECK (operation_type IN ('UPSERT', 'DELETE'))
      );

      CREATE INDEX IF NOT EXISTS idx_sync_outbox_v2_runnable
        ON sync_outbox_v2(account_id, state, next_attempt_at, lease_expires_at);
      CREATE INDEX IF NOT EXISTS idx_sync_outbox_v2_record
        ON sync_outbox_v2(account_id, record_type, record_id, created_at);
    `);

    await this.migrateRelationalIntegritySchema(db);
    await this.migrateEntryBlocksPrimaryKey(db);
    await this.ensureIntegrityTriggers(db);
    await this.cleanupRelationalIntegrityRows(db);
    await this.backfillStructuredTablesFromKv(db);
    await this.ensureSearchIndexes(db);
    await this.verifyForeignKeys(db);
    await this.setMeta(db, 'storage_schema_version', String(STORAGE_SCHEMA_VERSION));
    await this.setMeta(db, 'storage_backend', 'encrypted_sqlite');
  }

  private async tableExists(db: SQLiteDBConnection, tableName: string): Promise<boolean> {
    const result = await db.query(
      "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name = ? LIMIT 1;",
      [tableName],
    );
    return (result.values || []).length > 0;
  }

  private async tableReferences(
    db: SQLiteDBConnection,
    tableName: 'entries' | 'entry_blocks',
    referencedTable: string,
  ): Promise<boolean> {
    const result = await db.query(`PRAGMA foreign_key_list(${tableName});`);
    return (result.values || []).some(row => String(row.table) === referencedTable);
  }

  private async migrateRelationalIntegritySchema(db: SQLiteDBConnection): Promise<void> {
    const entriesHaveDiaryFk = await this.tableReferences(db, 'entries', 'diaries');
    const blocksHaveEntryFk = await this.tableReferences(db, 'entry_blocks', 'entries');
    if (entriesHaveDiaryFk && blocksHaveEntryFk) return;

    await db.execute('PRAGMA foreign_keys = OFF;');
    await db.beginTransaction();
    try {
      await db.execute(`
        DROP TABLE IF EXISTS entries_fts;
        DROP TABLE IF EXISTS notes_fts;
        DROP TABLE IF EXISTS entry_blocks_fk_migration_old;
        DROP TABLE IF EXISTS entries_fk_migration_old;
      `, false);

      if (await this.tableExists(db, 'entry_blocks')) {
        await db.run('ALTER TABLE entry_blocks RENAME TO entry_blocks_fk_migration_old;', [], false);
      }
      if (await this.tableExists(db, 'entries')) {
        await db.run('ALTER TABLE entries RENAME TO entries_fk_migration_old;', [], false);
      }

      await db.execute(`
        CREATE TABLE entries (
          id TEXT PRIMARY KEY NOT NULL,
          diary_id TEXT NOT NULL,
          date TEXT NOT NULL,
          time TEXT,
          title TEXT NOT NULL,
          body TEXT,
          mood_name TEXT,
          mood_emoji TEXT,
          tags_json TEXT NOT NULL,
          photo_uris_json TEXT NOT NULL,
          photo_count INTEGER NOT NULL DEFAULT 0,
          word_count INTEGER NOT NULL DEFAULT 0,
          audio_uri TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          is_timeline_bifurcated INTEGER NOT NULL DEFAULT 0,
          raw_json TEXT NOT NULL,
          FOREIGN KEY (diary_id) REFERENCES diaries(id) ON DELETE CASCADE ON UPDATE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_entries_diary_date ON entries(diary_id, date);
        CREATE INDEX IF NOT EXISTS idx_entries_updated_at ON entries(updated_at);
        CREATE INDEX IF NOT EXISTS idx_entries_created_at ON entries(created_at);
        CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(date);
        CREATE INDEX IF NOT EXISTS idx_entries_date_keyset ON entries(date, updated_at, id);
        CREATE INDEX IF NOT EXISTS idx_entries_created_keyset ON entries(created_at, id);
        CREATE INDEX IF NOT EXISTS idx_entries_updated_keyset ON entries(updated_at, id);

        CREATE TABLE entry_blocks (
          id TEXT NOT NULL,
          entry_id TEXT NOT NULL,
          position INTEGER NOT NULL,
          time TEXT,
          body TEXT,
          audio_uri TEXT,
          raw_json TEXT NOT NULL,
          PRIMARY KEY (entry_id, position),
          FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE ON UPDATE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_entry_blocks_entry ON entry_blocks(entry_id, position);

        CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
          id UNINDEXED,
          title,
          body,
          tags,
          mood
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
          id UNINDEXED,
          title,
          body,
          tags
        );
      `, false);

      if (await this.tableExists(db, 'entries_fk_migration_old')) {
        await db.run(`
          INSERT INTO entries (
            id, diary_id, date, time, title, body, mood_name, mood_emoji, tags_json,
            photo_uris_json, photo_count, word_count, audio_uri, created_at, updated_at,
            is_timeline_bifurcated, raw_json
          )
          SELECT
            id, diary_id, date, time, title, body, mood_name, mood_emoji, tags_json,
            photo_uris_json, photo_count, word_count, audio_uri, created_at, updated_at,
            is_timeline_bifurcated, raw_json
          FROM entries_fk_migration_old old_entries
          WHERE EXISTS (SELECT 1 FROM diaries WHERE diaries.id = old_entries.diary_id);
        `, [], false);
      }

      if (await this.tableExists(db, 'entry_blocks_fk_migration_old')) {
        await db.run(`
          INSERT OR REPLACE INTO entry_blocks (id, entry_id, position, time, body, audio_uri, raw_json)
          SELECT id, entry_id, position, time, body, audio_uri, raw_json
          FROM entry_blocks_fk_migration_old old_blocks
          WHERE EXISTS (SELECT 1 FROM entries WHERE entries.id = old_blocks.entry_id);
        `, [], false);
      }

      await db.execute(`
        DROP TABLE IF EXISTS entry_blocks_fk_migration_old;
        DROP TABLE IF EXISTS entries_fk_migration_old;
        DELETE FROM storage_meta WHERE key = '${SEARCH_INDEX_META_KEY}';
      `, false);
      await db.commitTransaction();
    } catch (error) {
      await db.rollbackTransaction().catch(() => undefined);
      throw error;
    } finally {
      await db.execute('PRAGMA foreign_keys = ON;').catch(() => undefined);
    }
  }

  private async ensureIntegrityTriggers(db: SQLiteDBConnection): Promise<void> {
    await db.execute(`
      CREATE TRIGGER IF NOT EXISTS trg_media_assets_owner_insert
      BEFORE INSERT ON media_assets
      BEGIN
        SELECT CASE
          WHEN NEW.owner_type = 'diary' AND NOT EXISTS (SELECT 1 FROM diaries WHERE id = NEW.owner_id)
            THEN RAISE(ABORT, 'media_asset_diary_owner_missing')
          WHEN NEW.owner_type = 'entry' AND NOT EXISTS (SELECT 1 FROM entries WHERE id = NEW.owner_id)
            THEN RAISE(ABORT, 'media_asset_entry_owner_missing')
          WHEN NEW.owner_type = 'note' AND NOT EXISTS (SELECT 1 FROM notes WHERE id = NEW.owner_id)
            THEN RAISE(ABORT, 'media_asset_note_owner_missing')
          WHEN NEW.owner_type NOT IN ('diary', 'entry', 'note')
            THEN RAISE(ABORT, 'media_asset_owner_type_invalid')
        END;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_media_assets_owner_update
      BEFORE UPDATE ON media_assets
      BEGIN
        SELECT CASE
          WHEN NEW.owner_type = 'diary' AND NOT EXISTS (SELECT 1 FROM diaries WHERE id = NEW.owner_id)
            THEN RAISE(ABORT, 'media_asset_diary_owner_missing')
          WHEN NEW.owner_type = 'entry' AND NOT EXISTS (SELECT 1 FROM entries WHERE id = NEW.owner_id)
            THEN RAISE(ABORT, 'media_asset_entry_owner_missing')
          WHEN NEW.owner_type = 'note' AND NOT EXISTS (SELECT 1 FROM notes WHERE id = NEW.owner_id)
            THEN RAISE(ABORT, 'media_asset_note_owner_missing')
          WHEN NEW.owner_type NOT IN ('diary', 'entry', 'note')
            THEN RAISE(ABORT, 'media_asset_owner_type_invalid')
        END;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_diaries_media_delete
      AFTER DELETE ON diaries
      BEGIN
        DELETE FROM media_assets WHERE owner_type = 'diary' AND owner_id = OLD.id;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_entries_media_delete
      AFTER DELETE ON entries
      BEGIN
        DELETE FROM media_assets WHERE owner_type = 'entry' AND owner_id = OLD.id;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_notes_media_delete
      AFTER DELETE ON notes
      BEGIN
        DELETE FROM media_assets WHERE owner_type = 'note' AND owner_id = OLD.id;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_sync_record_versions_type_insert
      BEFORE INSERT ON sync_record_versions
      WHEN NEW.record_type NOT IN ('diary', 'entry', 'note', 'settings', 'profile')
      BEGIN
        SELECT RAISE(ABORT, 'sync_record_version_type_invalid');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_sync_record_versions_type_update
      BEFORE UPDATE ON sync_record_versions
      WHEN NEW.record_type NOT IN ('diary', 'entry', 'note', 'settings', 'profile')
      BEGIN
        SELECT RAISE(ABORT, 'sync_record_version_type_invalid');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_sync_outbox_type_insert
      BEFORE INSERT ON sync_outbox
      WHEN NEW.record_type NOT IN ('diary', 'entry', 'note', 'settings', 'profile')
      BEGIN
        SELECT RAISE(ABORT, 'sync_outbox_record_type_invalid');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_sync_outbox_type_update
      BEFORE UPDATE ON sync_outbox
      WHEN NEW.record_type NOT IN ('diary', 'entry', 'note', 'settings', 'profile')
      BEGIN
        SELECT RAISE(ABORT, 'sync_outbox_record_type_invalid');
      END;
    `);
  }

  private async cleanupRelationalIntegrityRows(db: SQLiteDBConnection): Promise<void> {
    await db.execute(`
      DELETE FROM media_assets
      WHERE owner_type NOT IN ('diary', 'entry', 'note')
        OR (owner_type = 'diary' AND NOT EXISTS (SELECT 1 FROM diaries WHERE diaries.id = media_assets.owner_id))
        OR (owner_type = 'entry' AND NOT EXISTS (SELECT 1 FROM entries WHERE entries.id = media_assets.owner_id))
        OR (owner_type = 'note' AND NOT EXISTS (SELECT 1 FROM notes WHERE notes.id = media_assets.owner_id));

      DELETE FROM sync_record_versions
      WHERE record_type NOT IN ('diary', 'entry', 'note', 'settings', 'profile');

      DELETE FROM sync_outbox
      WHERE record_type NOT IN ('diary', 'entry', 'note', 'settings', 'profile');
    `);
  }

  private async verifyForeignKeys(db: SQLiteDBConnection): Promise<void> {
    const result = await db.query('PRAGMA foreign_key_check;');
    if ((result.values || []).length > 0) {
      throw new Error(`SQLite foreign key verification failed for ${result.values?.length || 0} row(s).`);
    }
  }

  private async migrateEntryBlocksPrimaryKey(db: SQLiteDBConnection): Promise<void> {
    const tableInfo = await db.query('PRAGMA table_info(entry_blocks);');
    const primaryKeyColumns = (tableInfo.values || [])
      .filter(column => Number(column.pk) > 0)
      .sort((left, right) => Number(left.pk) - Number(right.pk))
      .map(column => String(column.name));
    if (primaryKeyColumns.join(',') === 'entry_id,position') return;

    await db.beginTransaction();
    try {
      await db.execute(`
        DROP TABLE IF EXISTS entry_blocks;
        CREATE TABLE entry_blocks (
          id TEXT NOT NULL,
          entry_id TEXT NOT NULL,
          position INTEGER NOT NULL,
          time TEXT,
          body TEXT,
          audio_uri TEXT,
          raw_json TEXT NOT NULL,
          PRIMARY KEY (entry_id, position),
          FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE ON UPDATE CASCADE
        );
        CREATE INDEX idx_entry_blocks_entry ON entry_blocks(entry_id, position);
      `, false);
      await db.commitTransaction();
    } catch (error) {
      await db.rollbackTransaction().catch(() => undefined);
      throw error;
    }
  }

  private async backfillStructuredTablesFromKv(db: SQLiteDBConnection): Promise<void> {
    const schemaVersion = Number(await this.getMeta(db, 'storage_schema_version') || 0);
    if (schemaVersion >= STORAGE_SCHEMA_VERSION) return;

    const result = await db.query('SELECT key, value FROM kv_store;');
    const compatibilityValues = new Map<string, string>(
      (result.values || []).map(row => [String(row.key), String(row.value)]),
    );
    if (compatibilityValues.size === 0) return;

    await db.beginTransaction();
    try {
      for (const key of STRUCTURED_COMPATIBILITY_KEYS) {
        const value = compatibilityValues.get(key);
        if (value !== undefined) await this.syncStructuredTablesForKey(db, key, value, false);
      }
      await db.commitTransaction();
    } catch (error) {
      await db.rollbackTransaction().catch(() => undefined);
      throw error;
    }
  }

  private async migrateLegacyPreferences(db: SQLiteDBConnection): Promise<void> {
    const migratedAt = await this.getMeta(db, MIGRATION_META_KEY);
    if (migratedAt) return;

    const legacyValues = new Map<string, string>();
    for (const key of LEGACY_LOCAL_STORAGE_KEYS) {
      const { value } = await Preferences.get({ key });
      if (value !== null) legacyValues.set(key, value);
    }

    await db.beginTransaction();
    try {
      for (const [key, value] of legacyValues) {
        await db.run(
          `INSERT INTO kv_store (key, value, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;`,
          [key, value, now()],
          false,
        );
        await this.syncStructuredTablesForKey(db, key, value, false);
      }

      const verifiedCounts = await this.verifyLegacyMigration(db, legacyValues);
      await this.setMeta(db, 'legacy_migration_counts', JSON.stringify(verifiedCounts), false);
      await this.setMeta(db, MIGRATION_META_KEY, String(now()), false);
      await this.setMeta(db, 'legacy_preferences_retained', 'true', false);
      await db.commitTransaction();
    } catch (error) {
      await db.rollbackTransaction().catch(() => undefined);
      throw error;
    }
  }

  private async verifyLegacyMigration(
    db: SQLiteDBConnection,
    legacyValues: Map<string, string>,
  ): Promise<Record<string, number>> {
    for (const [key, expectedValue] of legacyValues) {
      const result = await db.query('SELECT value FROM kv_store WHERE key = ? LIMIT 1;', [key]);
      if (result.values?.[0]?.value !== expectedValue) {
        throw new Error(`SQLite migration verification failed for ${key}.`);
      }
    }

    const tableChecks = [
      ['deardiary_diaries', 'diaries'],
      ['deardiary_entries', 'entries'],
      ['deardiary_notes', 'notes'],
    ] as const;
    const counts: Record<string, number> = {};

    for (const [key, table] of tableChecks) {
      const sourceValue = legacyValues.get(key);
      if (sourceValue === undefined) continue;
      const sourceRecords = safeJsonParse<unknown[]>(sourceValue);
      if (!Array.isArray(sourceRecords)) {
        throw new Error(`SQLite migration source ${key} is not an array.`);
      }
      const result = await db.query(`SELECT COUNT(*) AS count FROM ${table};`);
      const migratedCount = Number(result.values?.[0]?.count || 0);
      if (migratedCount !== sourceRecords.length) {
        throw new Error(
          `SQLite migration count mismatch for ${key}: expected ${sourceRecords.length}, found ${migratedCount}.`,
        );
      }
      counts[table] = migratedCount;
    }

    return counts;
  }

  private async ensureSearchIndexes(db: SQLiteDBConnection): Promise<void> {
    if (await this.getMeta(db, SEARCH_INDEX_META_KEY) === '1') return;

    await db.beginTransaction();
    try {
      await db.run('DELETE FROM entries_fts;', [], false);
      await db.run('DELETE FROM notes_fts;', [], false);

      const entryRows = (await db.query('SELECT raw_json FROM entries;')).values || [];
      for (const row of entryRows) {
        const entry = safeJsonParse<Entry>(String(row.raw_json));
        if (entry) await this.upsertEntrySearchRow(db, entry, false);
      }

      const noteRows = (await db.query('SELECT raw_json FROM notes;')).values || [];
      for (const row of noteRows) {
        const note = safeJsonParse<Note>(String(row.raw_json));
        if (note) await this.upsertNoteSearchRow(db, note, false);
      }

      await this.setMeta(db, SEARCH_INDEX_META_KEY, '1', false);
      await db.commitTransaction();
    } catch (error) {
      await db.rollbackTransaction().catch(() => undefined);
      throw error;
    }
  }

  private async readStructuredValue(
    db: SQLiteDBConnection,
    key: string,
    compatibilityValue: string | null,
  ): Promise<string | null> {
    switch (key) {
      case 'deardiary_diaries':
        return this.readJsonRows(db, 'SELECT raw_json FROM diaries ORDER BY rowid;', compatibilityValue);
      case 'deardiary_entries':
        return this.readJsonRows(db, 'SELECT raw_json FROM entries ORDER BY rowid;', compatibilityValue);
      case 'deardiary_notes':
        return this.readJsonRows(db, 'SELECT raw_json FROM notes ORDER BY rowid;', compatibilityValue);
      case 'deardiary_settings': {
        const result = await db.query("SELECT value FROM app_settings WHERE key = 'current' LIMIT 1;");
        return result.values?.[0]?.value ?? compatibilityValue;
      }
      case 'deardiary_userprofile': {
        const result = await db.query("SELECT value FROM user_profile WHERE id = 'current' LIMIT 1;");
        return result.values?.[0]?.value ?? compatibilityValue;
      }
      case 'deardiary_sync_account': {
        const result = await db.query("SELECT value FROM sync_account WHERE id = 'current' LIMIT 1;");
        return result.values?.[0]?.value ?? compatibilityValue;
      }
      case 'deardiary_sync_record_versions':
        return this.readSyncRecordVersions(db, compatibilityValue);
      case 'deardiary_sync_media_pointers':
        return this.readJsonMapRows(db, 'SELECT pointer_key AS key, raw_json FROM sync_media_pointers ORDER BY rowid;', compatibilityValue);
      case 'deardiary_sync_partition_hydration':
        return this.readJsonMapRows(db, 'SELECT partition_key AS key, raw_json FROM sync_partition_hydration ORDER BY rowid;', compatibilityValue);
      case 'deardiary_sync_outbox':
        return this.readJsonMapRows(db, 'SELECT operation_id AS key, raw_json FROM sync_outbox ORDER BY created_at, rowid;', compatibilityValue);
      case 'deardiary_sync_outbox_v2':
        return this.readJsonMapRows(db, 'SELECT operation_id AS key, raw_json FROM sync_outbox_v2 ORDER BY created_at, rowid;', compatibilityValue);
      case 'deardiary_security':
      case 'deardiary_drive_backup':
      case 'deardiary_diary_viewmode': {
        const result = await db.query('SELECT value FROM storage_meta WHERE key = ? LIMIT 1;', [key]);
        return result.values?.[0]?.value ?? compatibilityValue;
      }
      default:
        return compatibilityValue;
    }
  }

  private async readJsonRows(
    db: SQLiteDBConnection,
    query: string,
    compatibilityValue: string | null,
  ): Promise<string | null> {
    const result = await db.query(query);
    const rows = result.values || [];
    if (rows.length === 0) {
      return compatibilityValue === null ? null : '[]';
    }

    const records = rows.map(row => safeJsonParse<unknown>(row.raw_json));
    if (records.some(record => record === null)) {
      return compatibilityValue;
    }
    return JSON.stringify(records);
  }

  private async readStructuredRows<T>(
    db: SQLiteDBConnection,
    key: string,
    query: string,
  ): Promise<T[] | undefined> {
    const result = await db.query(query);
    const rows = result.values || [];
    if (rows.length === 0) {
      return await this.isEmptyStructuredCollectionReady(db, key) ? [] : undefined;
    }

    const records = rows.map(row => safeJsonParse<T>(String(row.raw_json)));
    if (records.some(record => record === null)) return undefined;
    return records as T[];
  }

  private async readStructuredRecord<T>(
    db: SQLiteDBConnection,
    key: string,
    table: 'diaries' | 'entries' | 'notes',
    id: string,
  ): Promise<T | null | undefined> {
    const result = await db.query(`SELECT raw_json FROM ${table} WHERE id = ? LIMIT 1;`, [id]);
    const row = result.values?.[0];
    if (row) {
      const record = safeJsonParse<T>(String(row.raw_json));
      return record === null ? undefined : record;
    }
    return await this.isStructuredCollectionReady(db, key, table) ? null : undefined;
  }

  private async isStructuredCollectionReady(
    db: SQLiteDBConnection,
    key: string,
    table: 'diaries' | 'entries' | 'notes',
  ): Promise<boolean> {
    const countResult = await db.query(`SELECT COUNT(*) AS count FROM ${table};`);
    if (Number(countResult.values?.[0]?.count || 0) > 0) return true;
    return this.isEmptyStructuredCollectionReady(db, key);
  }

  private async isEmptyStructuredCollectionReady(db: SQLiteDBConnection, key: string): Promise<boolean> {
    const compatibilityResult = await db.query('SELECT value FROM kv_store WHERE key = ? LIMIT 1;', [key]);
    const compatibilityValue = compatibilityResult.values?.[0]?.value;
    if (typeof compatibilityValue !== 'string') return false;
    const compatibilityRecords = safeJsonParse<unknown[]>(compatibilityValue);
    return Array.isArray(compatibilityRecords) && compatibilityRecords.length === 0;
  }

  private buildEntryQuery(options: LocalEntryQueryOptions): { whereClause: string; params: Array<string | number> } {
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (options.diaryId) {
      clauses.push('diary_id = ?');
      params.push(options.diaryId);
    }
    if (options.yearMonth) {
      clauses.push('date LIKE ?');
      params.push(`${options.yearMonth}%`);
    }
    if (options.fromDate) {
      clauses.push('date >= ?');
      params.push(options.fromDate);
    }
    if (options.toDate) {
      clauses.push('date <= ?');
      params.push(options.toDate);
    }
    if (options.mood) {
      clauses.push('mood_name = ?');
      params.push(options.mood);
    }
    if (options.hasPhotos !== undefined) {
      clauses.push(options.hasPhotos ? 'photo_count > 0' : 'photo_count = 0');
    }
    if (options.query) {
      const ftsQuery = ftsQueryForText(options.query);
      if (ftsQuery) {
        clauses.push('id IN (SELECT id FROM entries_fts WHERE entries_fts MATCH ?)');
        params.push(ftsQuery);
      } else {
        clauses.push('1 = 0');
      }
    }
    for (const tag of options.tags || []) {
      clauses.push('LOWER(tags_json) LIKE ?');
      params.push(jsonTagLikePattern(tag));
    }
    this.addDiaryAccessClauses(clauses, params, options.allowedDiaryIds, options.excludeDiaryIds);

    return { whereClause: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', params };
  }

  private buildNoteQuery(options: LocalNoteQueryOptions): { whereClause: string; params: Array<string | number> } {
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (options.filter === 'pinned') clauses.push('is_pinned = 1');
    if (options.filter === 'tagged') clauses.push("tags_json <> '[]'");
    if (options.filter === 'untagged') clauses.push("tags_json = '[]'");
    const fromTimestamp = utcStartOfDay(options.fromDate);
    if (fromTimestamp !== undefined) {
      clauses.push('updated_at >= ?');
      params.push(fromTimestamp);
    }
    const toTimestamp = utcEndOfDay(options.toDate);
    if (toTimestamp !== undefined) {
      clauses.push('updated_at <= ?');
      params.push(toTimestamp);
    }
    if (options.query) {
      const ftsQuery = ftsQueryForText(options.query);
      if (ftsQuery) {
        clauses.push('id IN (SELECT id FROM notes_fts WHERE notes_fts MATCH ?)');
        params.push(ftsQuery);
      } else {
        clauses.push('1 = 0');
      }
    }
    for (const tag of options.tags || []) {
      clauses.push('LOWER(tags_json) LIKE ?');
      params.push(jsonTagLikePattern(tag));
    }

    return { whereClause: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', params };
  }

  private addDiaryAccessClauses(
    clauses: string[],
    params: Array<string | number>,
    allowedDiaryIds?: string[],
    excludeDiaryIds?: string[],
  ): void {
    if (allowedDiaryIds) {
      if (allowedDiaryIds.length === 0) {
        clauses.push('1 = 0');
      } else {
        clauses.push(`diary_id IN (${allowedDiaryIds.map(() => '?').join(', ')})`);
        params.push(...allowedDiaryIds);
      }
    }
    if (excludeDiaryIds?.length) {
      clauses.push(`diary_id NOT IN (${excludeDiaryIds.map(() => '?').join(', ')})`);
      params.push(...excludeDiaryIds);
    }
  }

  private entryOrderBy(sort: LocalEntryQueryOptions['sort'] = 'date-desc'): string {
    if (sort === 'date-asc') return 'date ASC, created_at ASC, id ASC';
    if (sort === 'updated-desc') return 'updated_at DESC, id ASC';
    if (sort === 'created-desc') return 'created_at DESC, id ASC';
    return 'date DESC, updated_at DESC, id ASC';
  }

  private noteOrderBy(sort: LocalNoteQueryOptions['sort'] = 'pinned-updated-desc'): string {
    if (sort === 'updated-desc') return 'updated_at DESC, id ASC';
    return 'is_pinned DESC, updated_at DESC, id ASC';
  }

  private combineWhereClauses(baseWhereClause: string, cursorClause: string): string {
    if (!baseWhereClause) return ` WHERE ${cursorClause}`;
    return `${baseWhereClause} AND ${cursorClause}`;
  }

  private entryKeysetClause(
    sort: LocalEntryQueryOptions['sort'] = 'date-desc',
    values: CursorValue[],
  ): { clause: string; params: Array<string | number> } {
    if (sort === 'date-asc') {
      const [date, createdAt, id] = values;
      return {
        clause: '(date > ? OR (date = ? AND created_at > ?) OR (date = ? AND created_at = ? AND id > ?))',
        params: [String(date || ''), String(date || ''), Number(createdAt || 0), String(date || ''), Number(createdAt || 0), String(id || '')],
      };
    }
    if (sort === 'updated-desc') {
      const [updatedAt, id] = values;
      return {
        clause: '(updated_at < ? OR (updated_at = ? AND id > ?))',
        params: [Number(updatedAt || 0), Number(updatedAt || 0), String(id || '')],
      };
    }
    if (sort === 'created-desc') {
      const [createdAt, id] = values;
      return {
        clause: '(created_at < ? OR (created_at = ? AND id > ?))',
        params: [Number(createdAt || 0), Number(createdAt || 0), String(id || '')],
      };
    }
    const [date, updatedAt, id] = values;
    return {
      clause: '(date < ? OR (date = ? AND updated_at < ?) OR (date = ? AND updated_at = ? AND id > ?))',
      params: [String(date || ''), String(date || ''), Number(updatedAt || 0), String(date || ''), Number(updatedAt || 0), String(id || '')],
    };
  }

  private noteKeysetClause(
    sort: LocalNoteQueryOptions['sort'] = 'pinned-updated-desc',
    values: CursorValue[],
  ): { clause: string; params: Array<string | number> } {
    if (sort === 'updated-desc') {
      const [updatedAt, id] = values;
      return {
        clause: '(updated_at < ? OR (updated_at = ? AND id > ?))',
        params: [Number(updatedAt || 0), Number(updatedAt || 0), String(id || '')],
      };
    }
    const [isPinned, updatedAt, id] = values;
    return {
      clause: '(is_pinned < ? OR (is_pinned = ? AND updated_at < ?) OR (is_pinned = ? AND updated_at = ? AND id > ?))',
      params: [Number(isPinned || 0), Number(isPinned || 0), Number(updatedAt || 0), Number(isPinned || 0), Number(updatedAt || 0), String(id || '')],
    };
  }

  private async countRows(
    db: SQLiteDBConnection,
    table: 'entries' | 'notes',
    whereClause: string,
    params: Array<string | number>,
  ): Promise<number> {
    const result = await db.query(`SELECT COUNT(*) AS count FROM ${table}${whereClause};`, params);
    return Number(result.values?.[0]?.count || 0);
  }

  private entryPageFromRows(
    rows: Array<{ raw_json?: unknown }>,
    total: number,
    limit: number,
    sort: LocalEntryQueryOptions['sort'] = 'date-desc',
  ): LocalQueryPageResult<Entry> | undefined {
    const parsedItems = rows.map(row => safeJsonParse<Entry>(String(row.raw_json)));
    if (parsedItems.some(item => item === null)) return undefined;
    const items = parsedItems as Entry[];
    const pageItems = items.slice(0, limit);
    return {
      items: pageItems,
      nextCursor: items.length > limit && pageItems.length > 0
        ? encodeKeysetCursor('entry', sort, entryCursorValues(pageItems[pageItems.length - 1], sort))
        : undefined,
      total,
    };
  }

  private notePageFromRows(
    rows: Array<{ raw_json?: unknown }>,
    total: number,
    limit: number,
    sort: LocalNoteQueryOptions['sort'] = 'pinned-updated-desc',
  ): LocalQueryPageResult<Note> | undefined {
    const items = rows.map(row => safeJsonParse<Note>(String(row.raw_json)));
    if (items.some(item => item === null)) return undefined;
    const pageItems = (items as Note[]).slice(0, limit);
    return {
      items: pageItems,
      nextCursor: items.length > limit && pageItems.length > 0
        ? encodeKeysetCursor('note', sort, noteCursorValues(pageItems[pageItems.length - 1], sort))
        : undefined,
      total,
    };
  }

  private redactedQueryMetadata(
    options: LocalEntryQueryOptions | LocalNoteQueryOptions,
  ): Record<string, string | number | boolean | undefined> {
    return {
      limit: options.limit,
      cursor: options.cursor ? 'set' : undefined,
      offset: options.offset,
      hasDateRange: Boolean('fromDate' in options && (options.fromDate || options.toDate)),
      hasAccessFilter: Boolean('allowedDiaryIds' in options && (options.allowedDiaryIds || options.excludeDiaryIds)),
      sort: 'sort' in options ? options.sort : undefined,
    };
  }

  private async readSyncRecordVersions(
    db: SQLiteDBConnection,
    compatibilityValue: string | null,
  ): Promise<string | null> {
    const result = await db.query('SELECT record_key, version FROM sync_record_versions ORDER BY rowid;');
    const rows = result.values || [];
    if (rows.length === 0) return compatibilityValue === null ? null : '{}';
    return JSON.stringify(Object.fromEntries(
      rows.map(row => [String(row.record_key), Number(row.version || 0)]),
    ));
  }

  private async readJsonMapRows(
    db: SQLiteDBConnection,
    query: string,
    compatibilityValue: string | null,
  ): Promise<string | null> {
    const result = await db.query(query);
    const rows = result.values || [];
    if (rows.length === 0) return compatibilityValue === null ? null : '{}';
    const entries = rows.map(row => [String(row.key), safeJsonParse<unknown>(row.raw_json)] as const);
    if (entries.some(([, value]) => value === null)) return compatibilityValue;
    return JSON.stringify(Object.fromEntries(entries));
  }

  private async setMeta(
    db: SQLiteDBConnection,
    key: string,
    value: string,
    transaction = true,
  ): Promise<void> {
    await db.run(
      `INSERT INTO storage_meta (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;`,
      [key, value, now()],
      transaction,
    );
  }

  private async getMeta(db: SQLiteDBConnection, key: string): Promise<string | null> {
    const result = await db.query('SELECT value FROM storage_meta WHERE key = ? LIMIT 1;', [key]);
    return result.values?.[0]?.value ?? null;
  }

  private async clearStructuredTablesForKey(db: SQLiteDBConnection, key: string): Promise<void> {
    switch (key) {
      case 'deardiary_diaries':
        await db.execute("DELETE FROM diaries; DELETE FROM media_assets WHERE owner_type = 'diary';");
        break;
      case 'deardiary_entries':
        await db.run('DELETE FROM entries;');
        await db.run('DELETE FROM entries_fts;');
        await db.run('DELETE FROM entry_blocks;');
        await db.run("DELETE FROM media_assets WHERE owner_type = 'entry';");
        break;
      case 'deardiary_notes':
        await db.execute('DELETE FROM notes;');
        await db.execute('DELETE FROM notes_fts;');
        break;
      case 'deardiary_settings':
        await db.run('DELETE FROM app_settings WHERE key = ?;', ['current']);
        break;
      case 'deardiary_userprofile':
        await db.run('DELETE FROM user_profile WHERE id = ?;', ['current']);
        break;
      case 'deardiary_sync_account':
        await db.run("DELETE FROM sync_account WHERE id = 'current';");
        break;
      case 'deardiary_sync_record_versions':
        await db.run('DELETE FROM sync_record_versions;');
        break;
      case 'deardiary_sync_media_pointers':
        await db.run('DELETE FROM sync_media_pointers;');
        break;
      case 'deardiary_sync_partition_hydration':
        await db.run('DELETE FROM sync_partition_hydration;');
        break;
      case 'deardiary_sync_outbox':
        await db.run('DELETE FROM sync_outbox;');
        break;
      case 'deardiary_sync_outbox_v2':
        await db.run('DELETE FROM sync_outbox_v2;');
        break;
      case 'deardiary_security':
      case 'deardiary_drive_backup':
      case 'deardiary_diary_viewmode':
        await db.run('DELETE FROM storage_meta WHERE key = ?;', [key]);
        break;
      default:
        break;
    }
  }

  private async writeSerializedItemsInTransaction(
    db: SQLiteDBConnection,
    items: Record<string, string>,
    transaction = true,
  ): Promise<void> {
    for (const [key, value] of Object.entries(items)) {
      await db.run(
        `INSERT INTO kv_store (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;`,
        [key, value, now()],
        transaction,
      );
      await this.syncStructuredTablesForKey(db, key, value, transaction);
    }
  }

  private async syncStructuredTablesForKey(
    db: SQLiteDBConnection,
    key: string,
    value: string,
    transaction = true,
  ): Promise<void> {
    switch (key) {
      case 'deardiary_diaries':
        await this.syncDiaries(db, value, transaction);
        break;
      case 'deardiary_entries':
        await this.syncEntries(db, value, transaction);
        break;
      case 'deardiary_notes':
        await this.syncNotes(db, value, transaction);
        break;
      case 'deardiary_settings':
        await db.run(
          `INSERT INTO app_settings (key, value, updated_at)
          VALUES ('current', ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;`,
          [value, now()],
          transaction,
        );
        break;
      case 'deardiary_userprofile':
        await db.run(
          `INSERT INTO user_profile (id, value, updated_at)
          VALUES ('current', ?, ?)
           ON CONFLICT(id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;`,
          [value, now()],
          transaction,
        );
        break;
      case 'deardiary_sync_account':
        await this.syncAccountState(db, value, transaction);
        break;
      case 'deardiary_sync_record_versions':
        await this.syncRecordVersions(db, value, transaction);
        break;
      case 'deardiary_sync_media_pointers':
        await this.syncMediaPointers(db, value, transaction);
        break;
      case 'deardiary_sync_partition_hydration':
        await this.syncPartitionHydration(db, value, transaction);
        break;
      case 'deardiary_sync_outbox':
        await this.syncOutbox(db, value, transaction);
        break;
      case 'deardiary_sync_outbox_v2':
        await this.syncOutboxV2(db, value, transaction);
        break;
      case 'deardiary_security':
      case 'deardiary_drive_backup':
      case 'deardiary_diary_viewmode':
        await this.setMeta(db, key, value, transaction);
        break;
      default:
        break;
    }
  }

  private async syncAccountState(db: SQLiteDBConnection, value: string, transaction = true): Promise<void> {
    const state = safeJsonParse<LocalSyncAccountState>(value);
    if (!state) return;
    await db.run(
      `INSERT INTO sync_account (
        id, account_id, device_id, current_sync_sequence, value, updated_at
      ) VALUES ('current', ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
        account_id = excluded.account_id,
        device_id = excluded.device_id,
        current_sync_sequence = excluded.current_sync_sequence,
        value = excluded.value,
        updated_at = excluded.updated_at;`,
      [
        state.accountId,
        state.deviceId,
        state.currentSyncSequence || 0,
        value,
        now(),
      ],
      transaction,
    );
  }

  private async syncRecordVersions(db: SQLiteDBConnection, value: string, transaction = true): Promise<void> {
    const versions = safeJsonParse<Record<string, number>>(value);
    if (!versions || typeof versions !== 'object') return;

    const incomingKeys = new Set(Object.keys(versions));
    const existingRows = (await db.query('SELECT record_key, version FROM sync_record_versions;')).values || [];
    const existingByKey = new Map(existingRows.map(row => [String(row.record_key), Number(row.version || 0)]));
    for (const row of existingRows) {
      const recordKey = String(row.record_key);
      if (!incomingKeys.has(recordKey)) await db.run('DELETE FROM sync_record_versions WHERE record_key = ?;', [recordKey], transaction);
    }
    for (const [recordKey, version] of Object.entries(versions)) {
      const numericVersion = Number(version || 0);
      if (existingByKey.get(recordKey) === numericVersion) continue;
      const separatorIndex = recordKey.indexOf(':');
      const recordType = separatorIndex > 0 ? recordKey.slice(0, separatorIndex) : 'unknown';
      const recordId = separatorIndex > 0 ? recordKey.slice(separatorIndex + 1) : recordKey;
      await db.run(
        `INSERT INTO sync_record_versions (record_key, record_type, record_id, version, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(record_key) DO UPDATE SET
          record_type = excluded.record_type,
          record_id = excluded.record_id,
          version = excluded.version,
          updated_at = excluded.updated_at;`,
        [recordKey, recordType, recordId, numericVersion, now()],
        transaction,
      );
    }
  }

  private async syncMediaPointers(db: SQLiteDBConnection, value: string, transaction = true): Promise<void> {
    const pointers = safeJsonParse<Record<string, SyncMediaPointer>>(value);
    if (!pointers || typeof pointers !== 'object') return;

    const incomingKeys = new Set(Object.keys(pointers));
    const existingRows = (await db.query('SELECT pointer_key, raw_json FROM sync_media_pointers;')).values || [];
    const existingByKey = new Map(existingRows.map(row => [String(row.pointer_key), String(row.raw_json)]));
    for (const row of existingRows) {
      const pointerKey = String(row.pointer_key);
      if (!incomingKeys.has(pointerKey)) await db.run('DELETE FROM sync_media_pointers WHERE pointer_key = ?;', [pointerKey], transaction);
    }
    for (const [pointerKey, pointer] of Object.entries(pointers)) {
      if (!pointer?.mediaId || !pointer.driveFileId) continue;
      const rawJson = JSON.stringify(pointer);
      if (existingByKey.get(pointerKey) === rawJson) continue;
      await db.run(
        `INSERT INTO sync_media_pointers (
          pointer_key, media_id, sequence, drive_file_id, sha256, size_bytes,
          local_uri, key_epoch, raw_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(pointer_key) DO UPDATE SET
          media_id = excluded.media_id,
          sequence = excluded.sequence,
          drive_file_id = excluded.drive_file_id,
          sha256 = excluded.sha256,
          size_bytes = excluded.size_bytes,
          local_uri = excluded.local_uri,
          key_epoch = excluded.key_epoch,
          raw_json = excluded.raw_json,
          updated_at = excluded.updated_at;`,
        [
          pointerKey,
          pointer.mediaId,
          pointer.sequence || 0,
          pointer.driveFileId,
          pointer.sha256,
          pointer.sizeBytes || 0,
          pointer.localUri || null,
          pointer.keyEpoch || null,
          rawJson,
          now(),
        ],
        transaction,
      );
    }
  }

  private async syncPartitionHydration(db: SQLiteDBConnection, value: string, transaction = true): Promise<void> {
    const states = safeJsonParse<Record<string, PartitionHydrationState>>(value);
    if (!states || typeof states !== 'object') return;

    const incomingKeys = new Set(Object.keys(states));
    const existingRows = (await db.query('SELECT partition_key, raw_json FROM sync_partition_hydration;')).values || [];
    const existingByKey = new Map(existingRows.map(row => [String(row.partition_key), String(row.raw_json)]));
    for (const row of existingRows) {
      const partitionKey = String(row.partition_key);
      if (!incomingKeys.has(partitionKey)) await db.run('DELETE FROM sync_partition_hydration WHERE partition_key = ?;', [partitionKey], transaction);
    }
    for (const [partitionKey, state] of Object.entries(states)) {
      if (!state?.partitionKey) continue;
      const rawJson = JSON.stringify(state);
      if (existingByKey.get(partitionKey) === rawJson) continue;
      await db.run(
        `INSERT INTO sync_partition_hydration (
          partition_key, status, last_applied_sequence, next_retry_at, raw_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(partition_key) DO UPDATE SET
          status = excluded.status,
          last_applied_sequence = excluded.last_applied_sequence,
          next_retry_at = excluded.next_retry_at,
          raw_json = excluded.raw_json,
          updated_at = excluded.updated_at;`,
        [
          partitionKey,
          state.status,
          state.lastAppliedSequence || 0,
          state.nextRetryAt || null,
          rawJson,
          now(),
        ],
        transaction,
      );
    }
  }

  private async syncOutbox(db: SQLiteDBConnection, value: string, transaction = true): Promise<void> {
    const operations = safeJsonParse<Record<string, SyncOutboxOperation>>(value);
    if (!operations || typeof operations !== 'object') return;

    const incomingKeys = new Set(Object.keys(operations));
    const existingRows = (await db.query('SELECT operation_id, raw_json FROM sync_outbox;')).values || [];
    const existingByKey = new Map(existingRows.map(row => [String(row.operation_id), String(row.raw_json)]));
    for (const row of existingRows) {
      const operationId = String(row.operation_id);
      if (!incomingKeys.has(operationId)) await db.run('DELETE FROM sync_outbox WHERE operation_id = ?;', [operationId], transaction);
    }
    for (const [operationId, operation] of Object.entries(operations)) {
      if (!operation?.operationId) continue;
      const rawJson = JSON.stringify(operation);
      if (existingByKey.get(operationId) === rawJson) continue;
      await db.run(
        `INSERT INTO sync_outbox (
          operation_id, account_id, device_id, partition_key, record_type, record_id,
          state, next_retry_at, created_at, updated_at, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(operation_id) DO UPDATE SET
          account_id = excluded.account_id,
          device_id = excluded.device_id,
          partition_key = excluded.partition_key,
          record_type = excluded.record_type,
          record_id = excluded.record_id,
          state = excluded.state,
          next_retry_at = excluded.next_retry_at,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          raw_json = excluded.raw_json;`,
        [
          operationId,
          operation.accountId,
          operation.deviceId,
          String(operation.partitionKey || ''),
          operation.recordType,
          operation.recordId,
          operation.state,
          operation.nextRetryAt || null,
          operation.createdAt || now(),
          operation.updatedAt || now(),
          rawJson,
        ],
        transaction,
      );
    }
  }

  async queryEntryProjections(
    options: LocalEntryQueryOptions,
  ): Promise<LocalQueryPageResult<LocalEntryProjection> | undefined> {
    return measureAsync('sqlite.query.entryProjections', async () => {
      const db = await this.ensureInitialized();
      if (!await this.isStructuredCollectionReady(db, 'deardiary_entries', 'entries')) return undefined;
      const sort = options.sort || 'date-desc';
      const { whereClause, params } = this.buildEntryQuery(options);
      const cursor = decodePageCursor(options.cursor, 'entry', sort);
      const keyset = cursor.kind === 'keyset' ? this.entryKeysetClause(sort, cursor.values) : null;
      const queryWhereClause = keyset ? this.combineWhereClauses(whereClause, keyset.clause) : whereClause;
      const queryParams = keyset ? [...params, ...keyset.params] : params;
      const limit = Math.max(1, Math.min(options.limit || 50, 10_000));
      const offset = cursor.kind === 'offset' ? (cursor.offset || options.offset || 0) : 0;
      const total = await this.countRows(db, 'entries', whereClause, params);
      const result = await db.query(
        `SELECT id, diary_id AS diaryId, date, time, title, mood_name AS moodName,
                mood_emoji AS moodEmoji, tags_json AS tagsJson, photo_uris_json AS photoUrisJson,
                photo_count AS photoCount, word_count AS wordCount, created_at AS createdAt,
                updated_at AS updatedAt
         FROM entries${queryWhereClause} ORDER BY ${this.entryOrderBy(sort)}
         LIMIT ?${cursor.kind === 'offset' ? ' OFFSET ?' : ''};`,
        cursor.kind === 'offset' ? [...queryParams, limit + 1, offset] : [...queryParams, limit + 1],
      );
      const items = (result.values || []).map(row => ({
        id: String(row.id),
        diaryId: String(row.diaryId),
        date: String(row.date),
        time: row.time === null || row.time === undefined ? undefined : String(row.time),
        title: String(row.title || ''),
        moodName: String(row.moodName || ''),
        moodEmoji: String(row.moodEmoji || ''),
        tags: safeJsonParse<string[]>(String(row.tagsJson || '[]')) || [],
        photoUris: safeJsonParse<string[]>(String(row.photoUrisJson || '[]')) || [],
        photoCount: Number(row.photoCount || 0),
        wordCount: Number(row.wordCount || 0),
        createdAt: Number(row.createdAt || 0),
        updatedAt: Number(row.updatedAt || 0),
      } satisfies LocalEntryProjection));
      const pageItems = items.slice(0, limit);
      return {
        items: pageItems,
        nextCursor: items.length > limit && pageItems.length > 0
          ? encodeKeysetCursor('entry', sort, entryCursorValues(pageItems[pageItems.length - 1], sort))
          : undefined,
        total,
      };
    }, { filters: this.redactedQueryMetadata(options) });
  }

  async queryNoteProjections(
    options: LocalNoteQueryOptions,
  ): Promise<LocalQueryPageResult<LocalNoteProjection> | undefined> {
    return measureAsync('sqlite.query.noteProjections', async () => {
      const db = await this.ensureInitialized();
      if (!await this.isStructuredCollectionReady(db, 'deardiary_notes', 'notes')) return undefined;
      const sort = options.sort || 'pinned-updated-desc';
      const { whereClause, params } = this.buildNoteQuery(options);
      const cursor = decodePageCursor(options.cursor, 'note', sort);
      const keyset = cursor.kind === 'keyset' ? this.noteKeysetClause(sort, cursor.values) : null;
      const queryWhereClause = keyset ? this.combineWhereClauses(whereClause, keyset.clause) : whereClause;
      const queryParams = keyset ? [...params, ...keyset.params] : params;
      const limit = Math.max(1, Math.min(options.limit || 50, 10_000));
      const offset = cursor.kind === 'offset' ? (cursor.offset || options.offset || 0) : 0;
      const total = await this.countRows(db, 'notes', whereClause, params);
      const result = await db.query(
        `SELECT id, title, is_pinned AS isPinned, tags_json AS tagsJson,
                created_at AS createdAt, updated_at AS updatedAt
         FROM notes${queryWhereClause} ORDER BY ${this.noteOrderBy(sort)}
         LIMIT ?${cursor.kind === 'offset' ? ' OFFSET ?' : ''};`,
        cursor.kind === 'offset' ? [...queryParams, limit + 1, offset] : [...queryParams, limit + 1],
      );
      const items = (result.values || []).map(row => ({
        id: String(row.id),
        title: String(row.title || ''),
        isPinned: Number(row.isPinned || 0) === 1,
        tags: safeJsonParse<string[]>(String(row.tagsJson || '[]')) || [],
        createdAt: Number(row.createdAt || 0),
        updatedAt: Number(row.updatedAt || 0),
      } satisfies LocalNoteProjection));
      const pageItems = items.slice(0, limit);
      return {
        items: pageItems,
        nextCursor: items.length > limit && pageItems.length > 0
          ? encodeKeysetCursor('note', sort, noteCursorValues(pageItems[pageItems.length - 1], sort))
          : undefined,
        total,
      };
    }, { filters: this.redactedQueryMetadata(options) });
  }

  private async syncOutboxV2(db: SQLiteDBConnection, value: string, transaction = true): Promise<void> {
    const operations = safeJsonParse<Record<string, SyncOutboxOperationV2>>(value);
    if (!operations || typeof operations !== 'object') return;
    const incomingKeys = new Set(Object.keys(operations));
    const existingRows = (await db.query('SELECT operation_id, raw_json FROM sync_outbox_v2;')).values || [];
    const existingByKey = new Map(existingRows.map(row => [String(row.operation_id), String(row.raw_json)]));
    for (const row of existingRows) {
      const operationId = String(row.operation_id);
      if (!incomingKeys.has(operationId)) await db.run('DELETE FROM sync_outbox_v2 WHERE operation_id = ?;', [operationId], transaction);
    }
    for (const [operationId, operation] of Object.entries(operations)) {
      if (!operation?.operationId) continue;
      const rawJson = JSON.stringify(operation);
      if (existingByKey.get(operationId) === rawJson) continue;
      await this.upsertOutboxV2Operation(db, operation, transaction);
    }
  }

  private async upsertOutboxV2Operation(
    db: SQLiteDBConnection,
    operation: SyncOutboxOperationV2,
    transaction = true,
  ): Promise<void> {
    await db.run(
      `INSERT INTO sync_outbox_v2 (
        operation_id, account_id, device_id, record_type, record_id, operation_type,
        base_record_version, state, retry_count, next_attempt_at, lease_owner,
        lease_expires_at, dependency_operation_id, created_at, updated_at, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(operation_id) DO UPDATE SET
        account_id = excluded.account_id, device_id = excluded.device_id,
        record_type = excluded.record_type, record_id = excluded.record_id,
        operation_type = excluded.operation_type, base_record_version = excluded.base_record_version,
        state = excluded.state, retry_count = excluded.retry_count,
        next_attempt_at = excluded.next_attempt_at, lease_owner = excluded.lease_owner,
        lease_expires_at = excluded.lease_expires_at,
        dependency_operation_id = excluded.dependency_operation_id,
        updated_at = excluded.updated_at, raw_json = excluded.raw_json;`,
      [operation.operationId, operation.accountId, operation.deviceId, operation.recordType, operation.recordId,
        operation.operationType, operation.baseRecordVersion, operation.state, operation.retryCount,
        operation.nextAttemptAt, operation.leaseOwner || null, operation.leaseExpiresAt || null,
        operation.dependencyOperationId || null, operation.createdAt, operation.updatedAt,
        JSON.stringify(operation)],
      transaction,
    );
  }

  private async syncDiaries(db: SQLiteDBConnection, value: string, transaction = true): Promise<void> {
    const diaries = safeJsonParse<Diary[]>(value);
    if (!Array.isArray(diaries)) return;

    const incomingIds = new Set(diaries.map(diary => diary.id));
    const existingRows = (await db.query('SELECT id, raw_json FROM diaries;')).values || [];
    const existingById = new Map(existingRows.map(row => [String(row.id), String(row.raw_json)]));
    for (const row of existingRows) {
      const id = String(row.id);
      if (incomingIds.has(id)) continue;
      await db.run('DELETE FROM diaries WHERE id = ?;', [id], transaction);
      await db.run("DELETE FROM media_assets WHERE owner_type = 'diary' AND owner_id = ?;", [id], transaction);
    }
    for (const diary of diaries) {
      const rawJson = JSON.stringify(diary);
      if (existingById.get(diary.id) === rawJson) continue;
      await db.run(
        `INSERT INTO diaries (
          id, name, emoji, color, is_locked, entry_count, last_updated, cover_image_uri,
          foil_icons_json, raw_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          emoji = excluded.emoji,
          color = excluded.color,
          is_locked = excluded.is_locked,
          entry_count = excluded.entry_count,
          last_updated = excluded.last_updated,
          cover_image_uri = excluded.cover_image_uri,
          foil_icons_json = excluded.foil_icons_json,
          raw_json = excluded.raw_json,
          updated_at = excluded.updated_at;`,
        [
          diary.id,
          diary.name,
          diary.emoji,
          diary.color,
          boolToInt(diary.isLocked),
          diary.entryCount || 0,
          diary.lastUpdated || null,
          diary.coverImage || null,
          JSON.stringify(diary.foilIcons || []),
          rawJson,
          now(),
        ],
        transaction,
      );

      await db.run("DELETE FROM media_assets WHERE owner_type = 'diary' AND owner_id = ?;", [diary.id], transaction);
      if (diary.coverImage) {
        await this.insertMediaAsset(db, 'diary', diary.id, 'coverImage', 0, diary.coverImage, transaction);
      }
    }
  }

  private async syncEntries(db: SQLiteDBConnection, value: string, transaction = true): Promise<void> {
    const entries = safeJsonParse<Entry[]>(value);
    if (!Array.isArray(entries)) return;

    const incomingIds = new Set(entries.map(entry => entry.id));
    const existingRows = (await db.query('SELECT id, raw_json FROM entries;')).values || [];
    const existingById = new Map(existingRows.map(row => [String(row.id), String(row.raw_json)]));
    for (const row of existingRows) {
      const id = String(row.id);
      if (incomingIds.has(id)) continue;
      await db.run('DELETE FROM entries WHERE id = ?;', [id], transaction);
      await this.deleteEntrySearchRow(db, id, transaction);
      await db.run('DELETE FROM entry_blocks WHERE entry_id = ?;', [id], transaction);
      await db.run("DELETE FROM media_assets WHERE owner_type = 'entry' AND owner_id = ?;", [id], transaction);
    }
    for (const entry of entries) {
      const rawJson = JSON.stringify(entry);
      if (existingById.get(entry.id) === rawJson) continue;
      await db.run(
        `INSERT INTO entries (
          id, diary_id, date, time, title, body, mood_name, mood_emoji, tags_json,
          photo_uris_json, photo_count, word_count, audio_uri, created_at, updated_at,
          is_timeline_bifurcated, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          diary_id = excluded.diary_id,
          date = excluded.date,
          time = excluded.time,
          title = excluded.title,
          body = excluded.body,
          mood_name = excluded.mood_name,
          mood_emoji = excluded.mood_emoji,
          tags_json = excluded.tags_json,
          photo_uris_json = excluded.photo_uris_json,
          photo_count = excluded.photo_count,
          word_count = excluded.word_count,
          audio_uri = excluded.audio_uri,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          is_timeline_bifurcated = excluded.is_timeline_bifurcated,
          raw_json = excluded.raw_json;`,
        [
          entry.id,
          entry.diaryId,
          entry.date,
          entry.time || null,
          entry.title,
          entry.body || '',
          entry.moodName || '',
          entry.moodEmoji || '',
          JSON.stringify(entry.tags || []),
          JSON.stringify(entry.photoUris || []),
          entry.photoCount || 0,
          entry.wordCount || 0,
          entry.audioUri || null,
          entry.createdAt || now(),
          entry.updatedAt || now(),
          boolToInt(entry.isTimelineBifurcated),
          rawJson,
        ],
        transaction,
      );

      await db.run('DELETE FROM entry_blocks WHERE entry_id = ?;', [entry.id], transaction);
      await db.run("DELETE FROM media_assets WHERE owner_type = 'entry' AND owner_id = ?;", [entry.id], transaction);
      for (const [index, uri] of (entry.photoUris || []).entries()) {
        await this.insertMediaAsset(db, 'entry', entry.id, 'photoUris', index, uri, transaction);
      }
      if (entry.audioUri) {
        await this.insertMediaAsset(db, 'entry', entry.id, 'audioUri', 0, entry.audioUri, transaction);
      }
      await this.upsertEntrySearchRow(db, entry, transaction);

      for (const [index, block] of (entry.blocks || []).entries()) {
        await db.run(
          `INSERT INTO entry_blocks (id, entry_id, position, time, body, audio_uri, raw_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(entry_id, position) DO UPDATE SET
             id = excluded.id,
             time = excluded.time,
             body = excluded.body,
             audio_uri = excluded.audio_uri,
             raw_json = excluded.raw_json;`,
          [
            block.id,
            entry.id,
            index,
            block.time || null,
            block.body || '',
            block.audioUri || null,
            JSON.stringify(block),
          ],
          transaction,
        );
        if (block.audioUri) {
          await this.insertMediaAsset(
            db,
            'entry',
            entry.id,
            `blocks.${block.id}.audioUri`,
            index,
            block.audioUri,
            transaction,
          );
        }
      }
    }
  }

  private async syncNotes(db: SQLiteDBConnection, value: string, transaction = true): Promise<void> {
    const notes = safeJsonParse<Note[]>(value);
    if (!Array.isArray(notes)) return;

    const incomingIds = new Set(notes.map(note => note.id));
    const existingRows = (await db.query('SELECT id, raw_json FROM notes;')).values || [];
    const existingById = new Map(existingRows.map(row => [String(row.id), String(row.raw_json)]));
    for (const row of existingRows) {
      const id = String(row.id);
      if (!incomingIds.has(id)) {
        await db.run('DELETE FROM notes WHERE id = ?;', [id], transaction);
        await this.deleteNoteSearchRow(db, id, transaction);
      }
    }
    for (const note of notes) {
      const rawJson = JSON.stringify(note);
      if (existingById.get(note.id) === rawJson) continue;
      await db.run(
        `INSERT INTO notes (id, title, body, is_pinned, tags_json, created_at, updated_at, raw_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           body = excluded.body,
           is_pinned = excluded.is_pinned,
           tags_json = excluded.tags_json,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at,
          raw_json = excluded.raw_json;`,
        [
          note.id,
          note.title,
          note.body || '',
          boolToInt(note.isPinned),
          JSON.stringify(note.tags || []),
          note.createdAt || now(),
          note.updatedAt || now(),
          rawJson,
        ],
        transaction,
      );
      await this.upsertNoteSearchRow(db, note, transaction);
    }
  }

  private async upsertStructuredRecord<T>(
    db: SQLiteDBConnection,
    key: string,
    id: string,
    value: T,
    transaction = true,
  ): Promise<void> {
    const recordId = (value as { id?: unknown })?.id;
    if (recordId !== id) throw new Error(`Structured SQLite record id mismatch for ${key}.`);
    switch (key) {
      case 'deardiary_diaries':
        await this.upsertDiaryRow(db, value as Diary, transaction);
        break;
      case 'deardiary_entries':
        await this.upsertEntryRow(db, value as Entry, transaction);
        break;
      case 'deardiary_notes':
        await this.upsertNoteRow(db, value as Note, transaction);
        break;
      default:
        break;
    }
  }

  private async deleteStructuredRecordRow(
    db: SQLiteDBConnection,
    key: string,
    id: string,
    transaction = true,
  ): Promise<void> {
    switch (key) {
      case 'deardiary_diaries':
        await db.run('DELETE FROM diaries WHERE id = ?;', [id], transaction);
        await db.run("DELETE FROM media_assets WHERE owner_type = 'diary' AND owner_id = ?;", [id], transaction);
        await this.markStructuredCollectionReadyIfEmpty(db, key, 'diaries', transaction);
        break;
      case 'deardiary_entries':
        await db.run('DELETE FROM entries WHERE id = ?;', [id], transaction);
        await this.deleteEntrySearchRow(db, id, transaction);
        await db.run('DELETE FROM entry_blocks WHERE entry_id = ?;', [id], transaction);
        await db.run("DELETE FROM media_assets WHERE owner_type = 'entry' AND owner_id = ?;", [id], transaction);
        await this.markStructuredCollectionReadyIfEmpty(db, key, 'entries', transaction);
        break;
      case 'deardiary_notes':
        await db.run('DELETE FROM notes WHERE id = ?;', [id], transaction);
        await this.deleteNoteSearchRow(db, id, transaction);
        await this.markStructuredCollectionReadyIfEmpty(db, key, 'notes', transaction);
        break;
      default:
        break;
    }
  }

  private async markStructuredCollectionReadyIfEmpty(
    db: SQLiteDBConnection,
    key: string,
    table: 'diaries' | 'entries' | 'notes',
    transaction = true,
  ): Promise<void> {
    const result = await db.query(`SELECT COUNT(*) AS count FROM ${table};`);
    if (Number(result.values?.[0]?.count || 0) > 0) return;
    await db.run(
      `INSERT INTO kv_store (key, value, updated_at)
       VALUES (?, '[]', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;`,
      [key, now()],
      transaction,
    );
  }

  private async upsertDiaryRow(db: SQLiteDBConnection, diary: Diary, transaction = true): Promise<void> {
    const rawJson = JSON.stringify(diary);
    await db.run(
      `INSERT INTO diaries (
        id, name, emoji, color, is_locked, entry_count, last_updated, cover_image_uri,
        foil_icons_json, raw_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        emoji = excluded.emoji,
        color = excluded.color,
        is_locked = excluded.is_locked,
        entry_count = excluded.entry_count,
        last_updated = excluded.last_updated,
        cover_image_uri = excluded.cover_image_uri,
        foil_icons_json = excluded.foil_icons_json,
        raw_json = excluded.raw_json,
        updated_at = excluded.updated_at;`,
      [
        diary.id,
        diary.name,
        diary.emoji,
        diary.color,
        boolToInt(diary.isLocked),
        diary.entryCount || 0,
        diary.lastUpdated || null,
        diary.coverImage || null,
        JSON.stringify(diary.foilIcons || []),
        rawJson,
        now(),
      ],
      transaction,
    );
    await db.run("DELETE FROM media_assets WHERE owner_type = 'diary' AND owner_id = ?;", [diary.id], transaction);
    if (diary.coverImage) await this.insertMediaAsset(db, 'diary', diary.id, 'coverImage', 0, diary.coverImage, transaction);
  }

  private async upsertEntryRow(db: SQLiteDBConnection, entry: Entry, transaction = true): Promise<void> {
    const rawJson = JSON.stringify(entry);
    await db.run(
      `INSERT INTO entries (
        id, diary_id, date, time, title, body, mood_name, mood_emoji, tags_json,
        photo_uris_json, photo_count, word_count, audio_uri, created_at, updated_at,
        is_timeline_bifurcated, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        diary_id = excluded.diary_id,
        date = excluded.date,
        time = excluded.time,
        title = excluded.title,
        body = excluded.body,
        mood_name = excluded.mood_name,
        mood_emoji = excluded.mood_emoji,
        tags_json = excluded.tags_json,
        photo_uris_json = excluded.photo_uris_json,
        photo_count = excluded.photo_count,
        word_count = excluded.word_count,
        audio_uri = excluded.audio_uri,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        is_timeline_bifurcated = excluded.is_timeline_bifurcated,
        raw_json = excluded.raw_json;`,
      [
        entry.id,
        entry.diaryId,
        entry.date,
        entry.time || null,
        entry.title,
        entry.body || '',
        entry.moodName || '',
        entry.moodEmoji || '',
        JSON.stringify(entry.tags || []),
        JSON.stringify(entry.photoUris || []),
        entry.photoCount || 0,
        entry.wordCount || 0,
        entry.audioUri || null,
        entry.createdAt || now(),
        entry.updatedAt || now(),
        boolToInt(entry.isTimelineBifurcated),
        rawJson,
      ],
      transaction,
    );

    await db.run('DELETE FROM entry_blocks WHERE entry_id = ?;', [entry.id], transaction);
    await db.run("DELETE FROM media_assets WHERE owner_type = 'entry' AND owner_id = ?;", [entry.id], transaction);
    for (const [index, uri] of (entry.photoUris || []).entries()) {
      await this.insertMediaAsset(db, 'entry', entry.id, 'photoUris', index, uri, transaction);
    }
    if (entry.audioUri) await this.insertMediaAsset(db, 'entry', entry.id, 'audioUri', 0, entry.audioUri, transaction);
    for (const [index, block] of (entry.blocks || []).entries()) {
      await db.run(
        `INSERT INTO entry_blocks (id, entry_id, position, time, body, audio_uri, raw_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(entry_id, position) DO UPDATE SET
           id = excluded.id,
           time = excluded.time,
           body = excluded.body,
           audio_uri = excluded.audio_uri,
           raw_json = excluded.raw_json;`,
        [
          block.id,
          entry.id,
          index,
          block.time || null,
          block.body || '',
          block.audioUri || null,
          JSON.stringify(block),
        ],
        transaction,
      );
      if (block.audioUri) {
        await this.insertMediaAsset(db, 'entry', entry.id, `blocks.${block.id}.audioUri`, index, block.audioUri, transaction);
      }
    }
    await this.upsertEntrySearchRow(db, entry, transaction);
  }

  private async upsertNoteRow(db: SQLiteDBConnection, note: Note, transaction = true): Promise<void> {
    await db.run(
      `INSERT INTO notes (id, title, body, is_pinned, tags_json, created_at, updated_at, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         body = excluded.body,
         is_pinned = excluded.is_pinned,
         tags_json = excluded.tags_json,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at,
         raw_json = excluded.raw_json;`,
      [
        note.id,
        note.title,
        note.body || '',
        boolToInt(note.isPinned),
        JSON.stringify(note.tags || []),
        note.createdAt || now(),
        note.updatedAt || now(),
        JSON.stringify(note),
      ],
      transaction,
    );
    await this.upsertNoteSearchRow(db, note, transaction);
  }

  private async upsertEntrySearchRow(db: SQLiteDBConnection, entry: Entry, transaction = true): Promise<void> {
    await this.deleteEntrySearchRow(db, entry.id, transaction);
    await db.run(
      'INSERT INTO entries_fts (id, title, body, tags, mood) VALUES (?, ?, ?, ?, ?);',
      [
        entry.id,
        entry.title || '',
        entry.body || '',
        (entry.tags || []).join(' '),
        entry.moodName || '',
      ],
      transaction,
    );
  }

  private async deleteEntrySearchRow(db: SQLiteDBConnection, id: string, transaction = true): Promise<void> {
    await db.run('DELETE FROM entries_fts WHERE id = ?;', [id], transaction);
  }

  private async upsertNoteSearchRow(db: SQLiteDBConnection, note: Note, transaction = true): Promise<void> {
    await this.deleteNoteSearchRow(db, note.id, transaction);
    await db.run(
      'INSERT INTO notes_fts (id, title, body, tags) VALUES (?, ?, ?, ?);',
      [
        note.id,
        note.title || '',
        note.body || '',
        (note.tags || []).join(' '),
      ],
      transaction,
    );
  }

  private async deleteNoteSearchRow(db: SQLiteDBConnection, id: string, transaction = true): Promise<void> {
    await db.run('DELETE FROM notes_fts WHERE id = ?;', [id], transaction);
  }

  private async upsertOutboxOperation(
    db: SQLiteDBConnection,
    operation: SyncOutboxOperation,
    transaction = true,
  ): Promise<void> {
    await db.run(
      `INSERT INTO sync_outbox (
        operation_id, account_id, device_id, partition_key, record_type, record_id,
        state, next_retry_at, created_at, updated_at, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(operation_id) DO UPDATE SET
        account_id = excluded.account_id,
        device_id = excluded.device_id,
        partition_key = excluded.partition_key,
        record_type = excluded.record_type,
        record_id = excluded.record_id,
        state = excluded.state,
        next_retry_at = excluded.next_retry_at,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        raw_json = excluded.raw_json;`,
      [
        operation.operationId,
        operation.accountId,
        operation.deviceId,
        String(operation.partitionKey || ''),
        operation.recordType,
        operation.recordId,
        operation.state,
        operation.nextRetryAt || null,
        operation.createdAt || now(),
        operation.updatedAt || now(),
        JSON.stringify(operation),
      ],
      transaction,
    );
  }

  private async insertMediaAsset(
    db: SQLiteDBConnection,
    ownerType: string,
    ownerId: string,
    field: string,
    position: number,
    uri: string,
    transaction = true,
  ): Promise<void> {
    const id = `${ownerType}:${ownerId}:${field}:${position}`;
    const mimeType = uri.startsWith('data:') ? uri.slice(5, uri.indexOf(';')) : null;
    await db.run(
      `INSERT INTO media_assets (
        id, owner_type, owner_id, field, position, uri, mime_type, byte_size, created_at, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        owner_type = excluded.owner_type,
        owner_id = excluded.owner_id,
        field = excluded.field,
        position = excluded.position,
        uri = excluded.uri,
        mime_type = excluded.mime_type,
        byte_size = excluded.byte_size,
        created_at = excluded.created_at,
        raw_json = excluded.raw_json;`,
      [
        id,
        ownerType,
        ownerId,
        field,
        position,
        uri,
        mimeType,
        uri.length,
        now(),
        JSON.stringify({ uri }),
      ],
      transaction,
    );
  }
}
