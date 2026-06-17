import { gunzipSync, gzipSync } from 'node:zlib';
import type { ParseResult } from '../../analyzers/base-analyzer.js';

const GZIP_BASE64_PREFIX = 'gz64:';
const DEFAULT_MIN_CHARS = 16 * 1024;
const DEFAULT_GZIP_LEVEL = 1;

export function encodeParseCachePayload(result: ParseResult): string {
  const json = JSON.stringify(result);
  if (!shouldCompressParseCache(json.length)) return json;
  const compressed = gzipSync(json, { level: parseCacheGzipLevel() }).toString('base64');
  return `${GZIP_BASE64_PREFIX}${compressed}`;
}

export function decodeParseCachePayload(value: string | Buffer): ParseResult {
  const text = Buffer.isBuffer(value) ? value.toString('utf-8') : value;
  const json = text.startsWith(GZIP_BASE64_PREFIX)
    ? gunzipSync(Buffer.from(text.substring(GZIP_BASE64_PREFIX.length), 'base64')).toString('utf-8')
    : text;
  return JSON.parse(json) as ParseResult;
}

function shouldCompressParseCache(charLength: number): boolean {
  if (envFlag(process.env.CODEGRAPH_DISABLE_PARSE_CACHE_COMPRESSION)) return false;
  return charLength >= boundedInt(process.env.CODEGRAPH_PARSE_CACHE_COMPRESSION_MIN_CHARS, DEFAULT_MIN_CHARS, 0, 10 * 1024 * 1024);
}

function parseCacheGzipLevel(): number {
  return boundedInt(process.env.CODEGRAPH_PARSE_CACHE_GZIP_LEVEL, DEFAULT_GZIP_LEVEL, 1, 9);
}

function envFlag(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

function boundedInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
