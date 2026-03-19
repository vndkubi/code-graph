import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { guardPath, toRelativePath, PathTraversalError } from '../../src/utils/path-guard.js';

describe('PathGuard', () => {
  const root = path.resolve('/test/repo');

  describe('guardPath', () => {
    it('should allow paths within root', () => {
      const result = guardPath('src/main.ts', root);
      expect(result).toBe(path.join(root, 'src', 'main.ts'));
    });

    it('should block directory traversal', () => {
      expect(() => guardPath('../../etc/passwd', root)).toThrow(PathTraversalError);
    });

    it('should block absolute traversal', () => {
      expect(() => guardPath('/etc/passwd', root)).toThrow(PathTraversalError);
    });

    it('should allow root itself', () => {
      const result = guardPath('.', root);
      expect(result).toBe(root);
    });
  });

  describe('toRelativePath', () => {
    it('should return relative path', () => {
      const abs = path.join(root, 'src', 'main.ts');
      const result = toRelativePath(abs, root);
      expect(result).toBe(path.join('src', 'main.ts'));
    });

    it('should block paths outside root', () => {
      expect(() => toRelativePath('/other/file.ts', root)).toThrow(PathTraversalError);
    });
  });
});
