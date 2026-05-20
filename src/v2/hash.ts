import crypto from 'node:crypto';
import fs from 'node:fs';

export function sha256Text(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function sha256Json(value: unknown): string {
  return sha256Text(JSON.stringify(value));
}

export function sha256File(filePath: string): string {
  const hash = crypto.createHash('sha256');
  const stream = fs.readFileSync(filePath);
  hash.update(stream);
  return hash.digest('hex');
}

export function stableId(parts: Array<string | undefined | null>): string {
  return sha256Text(parts.filter((part): part is string => Boolean(part)).join('\0')).slice(0, 32);
}
