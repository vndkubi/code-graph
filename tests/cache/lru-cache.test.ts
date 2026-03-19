import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LruCache } from '../../src/cache/lru-cache.js';

/**
 * LruCache uses fs.statSync on keys for mtime invalidation.
 * For non-file keys we still get caching (mtime=0), but the
 * get() call will fail if the "file" doesn't exist.
 * We use real temp files as cache keys in these tests.
 */
function tmpFile(name: string): string {
  const p = path.join(os.tmpdir(), `lru-test-${name}-${Date.now()}.txt`);
  fs.writeFileSync(p, name);
  return p;
}

describe('LruCache', () => {
  it('should store and retrieve values using file keys', () => {
    const k = tmpFile('a');
    const cache = new LruCache<string>(10, 60_000);
    cache.set(k, 'value1');
    expect(cache.get(k)).toBe('value1');
    fs.unlinkSync(k);
  });

  it('should return undefined for missing keys', () => {
    const cache = new LruCache<string>(10, 60_000);
    expect(cache.get('/nonexistent/file.txt')).toBeUndefined();
  });

  it('should evict LRU entry when capacity exceeded', () => {
    const a = tmpFile('a');
    const b = tmpFile('b');
    const c = tmpFile('c');
    const cache = new LruCache<string>(2, 60_000);
    cache.set(a, '1');
    cache.set(b, '2');
    cache.set(c, '3'); // 'a' evicted
    expect(cache.size).toBeLessThanOrEqual(2);
    expect(cache.get(b)).toBe('2');
    expect(cache.get(c)).toBe('3');
    [a, b, c].forEach(f => fs.unlinkSync(f));
  });

  it('should clear all entries', () => {
    const a = tmpFile('a');
    const b = tmpFile('b');
    const cache = new LruCache<string>(10, 60_000);
    cache.set(a, '1');
    cache.set(b, '2');
    cache.clear();
    expect(cache.size).toBe(0);
    [a, b].forEach(f => fs.unlinkSync(f));
  });

  it('should report size correctly', () => {
    const a = tmpFile('a');
    const b = tmpFile('b');
    const cache = new LruCache<string>(10, 60_000);
    cache.set(a, '1');
    cache.set(b, '2');
    expect(cache.size).toBe(2);
    [a, b].forEach(f => fs.unlinkSync(f));
  });

  it('should delete specific entries', () => {
    const a = tmpFile('a');
    const cache = new LruCache<string>(10, 60_000);
    cache.set(a, '1');
    cache.delete(a);
    expect(cache.size).toBe(0);
    fs.unlinkSync(a);
  });

  it('should invalidate when file is modified', () => {
    const a = tmpFile('a');
    const cache = new LruCache<string>(10, 60_000);
    cache.set(a, 'original');

    // Modify the file → mtime changes → cache invalidated
    fs.writeFileSync(a, 'modified');
    expect(cache.get(a)).toBeUndefined();
    fs.unlinkSync(a);
  });

  it('should invalidate when file is deleted', () => {
    const a = tmpFile('a');
    const cache = new LruCache<string>(10, 60_000);
    cache.set(a, 'value');
    fs.unlinkSync(a);
    expect(cache.get(a)).toBeUndefined();
  });
});
