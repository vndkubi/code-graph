import path from 'node:path';

/**
 * Validates that a given file path is within the allowed root directory.
 * Prevents directory traversal attacks (e.g., ../../etc/passwd).
 */
export function guardPath(filePath: string, rootDir: string): string {
  const resolved = path.resolve(rootDir, filePath);
  const normalizedRoot = path.resolve(rootDir);

  if (!resolved.startsWith(normalizedRoot + path.sep) && resolved !== normalizedRoot) {
    throw new PathTraversalError(filePath, rootDir);
  }

  return resolved;
}

/**
 * Returns a path relative to the root, or throws if outside root.
 */
export function toRelativePath(absolutePath: string, rootDir: string): string {
  const normalizedRoot = path.resolve(rootDir);
  const normalizedPath = path.resolve(absolutePath);

  if (!normalizedPath.startsWith(normalizedRoot + path.sep) && normalizedPath !== normalizedRoot) {
    throw new PathTraversalError(absolutePath, rootDir);
  }

  return path.relative(normalizedRoot, normalizedPath);
}

export class PathTraversalError extends Error {
  constructor(filePath: string, rootDir: string) {
    super(`Path traversal blocked: "${filePath}" is outside root "${rootDir}"`);
    this.name = 'PathTraversalError';
  }
}
