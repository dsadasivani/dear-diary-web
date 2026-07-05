import { CapacitorSQLite, SQLiteConnection, type SQLiteDBConnection } from '@capacitor-community/sqlite';
import { SecureStorage } from '@aparajita/capacitor-secure-storage';
import { Preferences } from '@capacitor/preferences';
import type { Diary, Entry, Note } from '../../types';
import type { LocalDataStore } from './LocalDataStore';

const DATABASE_NAME = 'dear_diary_local';
const DATABASE_VERSION = 1;
const SECURE_STORAGE_PREFIX = 'deardiary_';
const SQLITE_SECRET_KEY = 'sqlite_encryption_secret_v1';
const MIGRATION_META_KEY = 'legacy_preferences_migrated_at';

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

const now = (): number => Date.now();

const generateSecret = (): string => {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
};

const boolToInt = (value: unknown): number => value ? 1 : 0;

const safeJsonParse = <T>(value: string): T | null => {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    console.warn('Failed to parse SQLite mirror payload:', error);
    return null;
  }
};

export class NativeSQLiteDataStore implements LocalDataStore {
  private sqlite = new SQLiteConnection(CapacitorSQLite);
  private db: SQLiteDBConnection | null = null;
  private initPromise: Promise<SQLiteDBConnection> | null = null;
  private writeTail: Promise<void> = Promise.resolve();
  private sqliteUnavailable = false;
  private fallbackWarned = false;

  constructor(private fallback: LocalDataStore) {}

  async getItem(key: string): Promise<string | null> {
    const db = await this.getDbOrFallback();
    if (!db) return this.fallback.getItem(key);

    const compatibilityResult = await db.query('SELECT value FROM kv_store WHERE key = ? LIMIT 1;', [key]);
    const compatibilityValue = compatibilityResult.values?.[0]?.value ?? null;
    return this.readStructuredValue(db, key, compatibilityValue);
  }

  async setItem(key: string, value: string): Promise<void> {
    await this.setItems({ [key]: value });
  }

  async setItems(items: Record<string, string>): Promise<void> {
    await this.enqueueWrite(async () => {
      const db = await this.getDbOrFallback();
      if (!db) {
        await this.fallback.setItems(items);
        return;
      }

      await db.beginTransaction();
      try {
        for (const [key, value] of Object.entries(items)) {
          await db.run(
            `INSERT INTO kv_store (key, value, updated_at)
             VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;`,
            [key, value, now()],
            false,
          );
          await this.syncStructuredTablesForKey(db, key, value, false);
        }
        await db.commitTransaction();
      } catch (error) {
        await db.rollbackTransaction().catch(() => undefined);
        throw error;
      }
    });
  }

  async removeItem(key: string): Promise<void> {
    await this.enqueueWrite(async () => {
      const db = await this.getDbOrFallback();
      if (!db) {
        await this.fallback.removeItem(key);
        return;
      }

      await db.run('DELETE FROM kv_store WHERE key = ?;', [key]);
      await this.clearStructuredTablesForKey(db, key);
    });
  }

  async clear(): Promise<void> {
    await this.enqueueWrite(async () => {
      const db = await this.getDbOrFallback();
      if (!db) {
        await this.fallback.clear();
        return;
      }

      await db.execute(`
        DELETE FROM kv_store;
        DELETE FROM diaries;
        DELETE FROM entries;
        DELETE FROM entry_blocks;
        DELETE FROM notes;
        DELETE FROM media_assets;
        DELETE FROM app_settings;
        DELETE FROM user_profile;
        DELETE FROM storage_meta;
      `);
      await this.fallback.clear();
      await this.setMeta(db, 'storage_schema_version', String(DATABASE_VERSION));
      await this.setMeta(db, 'storage_backend', 'encrypted_sqlite');
      await this.setMeta(db, MIGRATION_META_KEY, String(now()));
      await this.setMeta(db, 'legacy_preferences_retained', 'false');
    });
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeTail.then(operation, operation);
    this.writeTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async getDbOrFallback(): Promise<SQLiteDBConnection | null> {
    if (this.sqliteUnavailable) return null;

    try {
      return await this.ensureInitialized();
    } catch (error) {
      this.sqliteUnavailable = true;
      if (!this.fallbackWarned) {
        console.warn('Encrypted SQLite storage unavailable; falling back to Capacitor Preferences:', error);
        this.fallbackWarned = true;
      }
      return null;
    }
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
        raw_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_entries_diary_date ON entries(diary_id, date);
      CREATE INDEX IF NOT EXISTS idx_entries_updated_at ON entries(updated_at);

      CREATE TABLE IF NOT EXISTS entry_blocks (
        id TEXT PRIMARY KEY NOT NULL,
        entry_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        time TEXT,
        body TEXT,
        audio_uri TEXT,
        raw_json TEXT NOT NULL
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
        raw_json TEXT
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
    `);

    await this.setMeta(db, 'storage_schema_version', String(DATABASE_VERSION));
    await this.setMeta(db, 'storage_backend', 'encrypted_sqlite');
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
        await db.execute("DELETE FROM entries; DELETE FROM entry_blocks; DELETE FROM media_assets WHERE owner_type = 'entry';");
        break;
      case 'deardiary_notes':
        await db.execute('DELETE FROM notes;');
        break;
      case 'deardiary_settings':
        await db.run('DELETE FROM app_settings WHERE key = ?;', ['current']);
        break;
      case 'deardiary_userprofile':
        await db.run('DELETE FROM user_profile WHERE id = ?;', ['current']);
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
      case 'deardiary_security':
      case 'deardiary_drive_backup':
      case 'deardiary_diary_viewmode':
        await this.setMeta(db, key, value, transaction);
        break;
      default:
        break;
    }
  }

  private async syncDiaries(db: SQLiteDBConnection, value: string, transaction = true): Promise<void> {
    const diaries = safeJsonParse<Diary[]>(value);
    if (!Array.isArray(diaries)) return;

    await db.execute("DELETE FROM diaries; DELETE FROM media_assets WHERE owner_type = 'diary';", transaction);
    for (const diary of diaries) {
      await db.run(
        `INSERT INTO diaries (
          id, name, emoji, color, is_locked, entry_count, last_updated, cover_image_uri,
          foil_icons_json, raw_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
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
          JSON.stringify(diary),
          now(),
        ],
        transaction,
      );

      if (diary.coverImage) {
        await this.insertMediaAsset(db, 'diary', diary.id, 'coverImage', 0, diary.coverImage, transaction);
      }
    }
  }

  private async syncEntries(db: SQLiteDBConnection, value: string, transaction = true): Promise<void> {
    const entries = safeJsonParse<Entry[]>(value);
    if (!Array.isArray(entries)) return;

    await db.execute(
      "DELETE FROM entries; DELETE FROM entry_blocks; DELETE FROM media_assets WHERE owner_type = 'entry';",
      transaction,
    );
    for (const entry of entries) {
      await db.run(
        `INSERT INTO entries (
          id, diary_id, date, time, title, body, mood_name, mood_emoji, tags_json,
          photo_uris_json, photo_count, word_count, audio_uri, created_at, updated_at,
          is_timeline_bifurcated, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
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
          JSON.stringify(entry),
        ],
        transaction,
      );

      for (const [index, uri] of (entry.photoUris || []).entries()) {
        await this.insertMediaAsset(db, 'entry', entry.id, 'photoUris', index, uri, transaction);
      }
      if (entry.audioUri) {
        await this.insertMediaAsset(db, 'entry', entry.id, 'audioUri', 0, entry.audioUri, transaction);
      }

      for (const [index, block] of (entry.blocks || []).entries()) {
        await db.run(
          `INSERT INTO entry_blocks (id, entry_id, position, time, body, audio_uri, raw_json)
           VALUES (?, ?, ?, ?, ?, ?, ?);`,
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

    await db.execute('DELETE FROM notes;', transaction);
    for (const note of notes) {
      await db.run(
        `INSERT INTO notes (id, title, body, is_pinned, tags_json, created_at, updated_at, raw_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
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
    }
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
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
