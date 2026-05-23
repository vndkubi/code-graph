import fs from 'node:fs';
import path from 'node:path';
import { TreeSitterAnalyzer } from '../../analyzers/tree-sitter-analyzer.js';
import { detectFrameworkRoles, synthesizeLombokSymbols } from '../../analyzers/java-framework-detector.js';
import type { ParseResult } from '../../analyzers/base-analyzer.js';
import { parseConfigFile } from './config-parser.js';

const analyzer = new TreeSitterAnalyzer();

export function parseFile(absPath: string, rootDir: string): ParseResult {
  const content = fs.readFileSync(absPath, 'utf-8');
  const configResult = parseConfigFile(absPath, content, rootDir);
  if (configResult) return configResult;

  let result: ParseResult;
  try {
    result = analyzer.parse(absPath, content, rootDir);
  } catch {
    return {
      file: path.relative(rootDir, absPath).replace(/\\/g, '/'),
      symbols: [],
      imports: [],
      calls: [],
      references: [],
      hasParseErrors: true,
      parseConfidence: 0,
    };
  }

  if (absPath.endsWith('.java')) {
    detectFrameworkRoles(result.symbols);
    result.symbols.push(...synthesizeLombokSymbols(result.symbols, result.file));
  }

  return result;
}

export function symbolFqName(symbol: {
  packageName?: string;
  parent?: string;
  name: string;
  kind: string;
  parameterTypes?: string[];
}): string {
  const owner = symbol.parent ? `${symbol.parent}.` : '';
  const params = symbol.kind === 'method' || symbol.kind === 'function'
    ? `(${(symbol.parameterTypes ?? []).join(',')})`
    : '';
  const packagePrefix = symbol.packageName ? `${symbol.packageName}.` : '';
  return `${packagePrefix}${owner}${symbol.name}${params}`;
}
