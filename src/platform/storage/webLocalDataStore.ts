import type { LocalDataStore } from './LocalDataStore';
import { REPOSITORY_STORE, WebEncryptedKeyValueStore } from './webEncryptedKeyValueStore';

export class WebLocalDataStore implements LocalDataStore {
  private readonly encryptedStore = new WebEncryptedKeyValueStore(REPOSITORY_STORE);

  private get useTestFallback(): boolean {
    return typeof indexedDB === 'undefined' && typeof window === 'undefined';
  }

  private requireEncryptedBrowserStorage(): void {
    if (typeof indexedDB === 'undefined' && !this.useTestFallback) {
      throw new Error('This browser cannot provide encrypted local diary storage.');
    }
  }

  async getItem(key: string): Promise<string | null> {
    this.requireEncryptedBrowserStorage();
    if (this.useTestFallback) return localStorage.getItem(key);
    const encrypted = await this.encryptedStore.getItem(key);
    if (encrypted !== null) return encrypted;
    const legacy = localStorage.getItem(key);
    if (legacy !== null) {
      await this.encryptedStore.setItem(key, legacy);
      localStorage.removeItem(key);
    }
    return legacy;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.requireEncryptedBrowserStorage();
    if (this.useTestFallback) { localStorage.setItem(key, value); return; }
    await this.encryptedStore.setItem(key, value);
    localStorage.removeItem(key);
  }

  async setItems(items: Record<string, string>): Promise<void> {
    this.requireEncryptedBrowserStorage();
    if (this.useTestFallback) {
      Object.entries(items).forEach(([key, value]) => localStorage.setItem(key, value));
      return;
    }
    await this.encryptedStore.setItems(items);
    Object.keys(items).forEach(key => localStorage.removeItem(key));
  }

  async removeItem(key: string): Promise<void> {
    this.requireEncryptedBrowserStorage();
    if (this.useTestFallback) { localStorage.removeItem(key); return; }
    await this.encryptedStore.removeItem(key);
    localStorage.removeItem(key);
  }

  async clear(): Promise<void> {
    this.requireEncryptedBrowserStorage();
    if (this.useTestFallback) { localStorage.clear(); return; }
    await this.encryptedStore.clear();
  }
}
