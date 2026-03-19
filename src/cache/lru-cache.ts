import fs from 'node:fs';

interface CacheEntry<T> {
  value: T;
  mtime: number;
  accessTime: number;
}

/**
 * LRU cache with file-change invalidation via mtime.
 * Entries are evicted when capacity is exceeded (least recently accessed first).
 */
export class LruCache<T> {
  private readonly cache = new Map<string, CacheEntry<T>>();
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor(maxSize: number = 1000, ttlMs: number = 300_000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    // TTL check
    if (Date.now() - entry.accessTime > this.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }

    // File mtime check — invalidate if file changed
    try {
      const stat = fs.statSync(key);
      if (stat.mtimeMs !== entry.mtime) {
        this.cache.delete(key);
        return undefined;
      }
    } catch {
      // File deleted or inaccessible — invalidate
      this.cache.delete(key);
      return undefined;
    }

    // Update access time (LRU refresh)
    entry.accessTime = Date.now();
    return entry.value;
  }

  set(key: string, value: T): void {
    // Evict LRU entries if at capacity
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      this.evictLru();
    }

    let mtime = 0;
    try {
      mtime = fs.statSync(key).mtimeMs;
    } catch {
      // Non-file keys get mtime 0
    }

    this.cache.set(key, { value, mtime, accessTime: Date.now() });
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  private evictLru(): void {
    let oldestKey: string | undefined;
    let oldestAccess = Infinity;

    for (const [key, entry] of this.cache) {
      if (entry.accessTime < oldestAccess) {
        oldestAccess = entry.accessTime;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
    }
  }
}
