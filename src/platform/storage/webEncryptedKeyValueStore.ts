const DATABASE_NAME = 'dear_diary_secure_v1';
const DATABASE_VERSION = 2;
const KEY_STORE = 'keys';
export const SYNC_SECRET_STORE = 'values';
export const REPOSITORY_STORE = 'repository';

interface EncryptedValue {
  nonce: number[];
  ciphertext: number[];
}

const requestResult = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error || new Error('Encrypted browser storage request failed.'));
});

const transactionDone = (transaction: IDBTransaction): Promise<void> => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onabort = () => reject(transaction.error || new Error('Encrypted browser storage transaction aborted.'));
  transaction.onerror = () => reject(transaction.error || new Error('Encrypted browser storage transaction failed.'));
});

let databasePromise: Promise<IDBDatabase> | null = null;
let wrappingKeyPromise: Promise<CryptoKey> | null = null;

const openDatabase = (): Promise<IDBDatabase> => {
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        [KEY_STORE, SYNC_SECRET_STORE, REPOSITORY_STORE].forEach(store => {
          if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store);
        });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Encrypted browser storage could not be opened.'));
    });
  }
  return databasePromise;
};

const getWrappingKey = (): Promise<CryptoKey> => {
  if (!wrappingKeyPromise) {
    wrappingKeyPromise = (async () => {
      const database = await openDatabase();
      const existing = await requestResult(database.transaction(KEY_STORE).objectStore(KEY_STORE).get('root'));
      if (existing instanceof CryptoKey) return existing;
      const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      await requestResult(database.transaction(KEY_STORE, 'readwrite').objectStore(KEY_STORE).put(key, 'root'));
      return key;
    })();
  }
  return wrappingKeyPromise;
};

export class WebEncryptedKeyValueStore {
  constructor(private readonly storeName: string) {}

  async getItem(key: string): Promise<string | null> {
    const database = await openDatabase();
    const record = await requestResult<EncryptedValue | undefined>(
      database.transaction(this.storeName).objectStore(this.storeName).get(key),
    );
    if (!record) return null;
    try {
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(record.nonce) },
        await getWrappingKey(),
        new Uint8Array(record.ciphertext),
      );
      return new TextDecoder().decode(plaintext);
    } catch {
      throw new Error('Encrypted browser storage authentication failed.');
    }
  }

  async setItem(key: string, value: string): Promise<void> {
    await this.setItems({ [key]: value });
  }

  async setItems(items: Record<string, string>): Promise<void> {
    const wrappingKey = await getWrappingKey();
    const encryptedItems = await Promise.all(Object.entries(items).map(async ([key, value]) => {
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: nonce },
        wrappingKey,
        new TextEncoder().encode(value),
      );
      return [key, {
        nonce: Array.from(nonce),
        ciphertext: Array.from(new Uint8Array(ciphertext)),
      }] as const;
    }));
    const database = await openDatabase();
    const transaction = database.transaction(this.storeName, 'readwrite');
    const store = transaction.objectStore(this.storeName);
    encryptedItems.forEach(([key, value]) => {
      store.put(value, key);
    });
    await transactionDone(transaction);
  }

  async removeItem(key: string): Promise<void> {
    const database = await openDatabase();
    await requestResult(database.transaction(this.storeName, 'readwrite').objectStore(this.storeName).delete(key));
  }

  async clear(): Promise<void> {
    const database = await openDatabase();
    await requestResult(database.transaction(this.storeName, 'readwrite').objectStore(this.storeName).clear());
  }
}
