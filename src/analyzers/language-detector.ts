import path from 'node:path';

export type SupportedLanguage =
  | 'java'
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'kotlin'
  | 'swift'
  | 'csharp'
  | 'php'
  | 'xml'
  | 'json'
  | 'yaml'
  | 'properties';

const EXTENSION_MAP: Record<string, SupportedLanguage> = {
  '.java': 'java',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.swift': 'swift',
  '.cs': 'csharp',
  '.php': 'php',
  '.xml': 'xml',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.properties': 'properties',
};

const SOURCE_EXTENSIONS = new Set(Object.keys(EXTENSION_MAP));

/** Default glob patterns to exclude from indexing */
export const DEFAULT_EXCLUDES = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/target/**',
  '**/.git/**',
  '**/vendor/**',
  '**/__pycache__/**',
  '**/bin/**',
  '**/obj/**',
  '**/.gradle/**',
  '**/.idea/**',
  '**/.vscode/**',
];

export function detectLanguage(filePath: string): SupportedLanguage | undefined {
  const ext = path.extname(filePath).toLowerCase();
  return EXTENSION_MAP[ext];
}

export function isSourceFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return SOURCE_EXTENSIONS.has(ext);
}

export function getSupportedExtensions(): string[] {
  return [...SOURCE_EXTENSIONS];
}
