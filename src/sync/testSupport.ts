import type { LocalDataStore } from '../platform/storage';
import { LocalDiaryRepository } from '../repositories/localDiaryRepository';

export class MemoryDataStore implements LocalDataStore {
  private readonly values = new Map<string, string>();
  async getItem(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }
  async setItem(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
  async setItems(items: Record<string, string>): Promise<void> {
    Object.entries(items).forEach(([key, value]) => this.values.set(key, value));
  }
  async removeItem(key: string): Promise<void> {
    this.values.delete(key);
  }
  async clear(): Promise<void> {
    this.values.clear();
  }
}

export const createRepository = async (
  store = new MemoryDataStore(),
): Promise<LocalDiaryRepository> => {
  const repository = new LocalDiaryRepository(store);
  await repository.initialize();
  return repository;
};
