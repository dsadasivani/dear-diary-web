export interface LocalDataStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  setItems(items: Record<string, string>): Promise<void>;
  removeItem(key: string): Promise<void>;
  clear(): Promise<void>;
}
