/**
 * Shared types for code analysis across all language parsers.
 */

export type SymbolKind = 'class' | 'interface' | 'function' | 'method' | 'variable' | 'enum' | 'type' | 'field';
export type Visibility = 'public' | 'private' | 'protected' | 'internal';
export type ReferenceKind = 'call' | 'import' | 'definition' | 'type';

/**
 * A reference to a type used in field/parameter/return position.
 * Used to augment dependency edges when imports cannot be resolved.
 */
export interface TypeRefInfo {
  file: string;
  referencedType: string;   // Simple class name, e.g. "UserRepository"
  context: 'field' | 'parameter' | 'return';
  line: number;
}

export interface SymbolInfo {
  /** Optional fully-qualified/indexer-native name. Defaults to package.parent.name when omitted. */
  fqName?: string;
  name: string;
  kind: SymbolKind;
  file: string;
  line: number;
  column: number;
  endLine: number;
  signature: string;
  visibility: Visibility;
  module: string;
  parent?: string;             // Enclosing class/module name

  // Java-specific structural info
  extends?: string;            // Superclass name (class declarations)
  implements?: string[];       // Implemented interface names
  annotations?: string[];      // Simple annotation names, e.g. ['Service', 'Transactional']
  isStatic?: boolean;          // Has static modifier
  packageName?: string;        // Package this symbol belongs to
  returnType?: string;         // Method/function return type (simple name)
  parameterTypes?: string[];   // Method parameter types (simple names)

  // Framework classification (set by java-framework-detector)
  frameworkRole?: string;      // e.g. 'spring:service', 'jakarta:entity', 'test:test'
  frameworkMeta?: Record<string, string>; // e.g. { httpMethod: 'GET', path: '/api/users' }
}

export interface ImportInfo {
  source: string;          // Module path / package name (e.g., "java.util.List", "./order-service")
  symbols: string[];       // Imported symbol names (empty = wildcard/default import)
  file: string;            // File where the import appears
  line: number;
  isExternal: boolean;     // true if third-party package
}

export interface ReferenceInfo {
  file: string;
  line: number;
  column: number;
  kind: ReferenceKind;
  context: string;         // Source line(s) around the reference
  symbolName: string;
}

export interface CallInfo {
  caller: string;          // "ClassName.methodName" or "functionName"
  callee: string;          // Target symbol being called
  file: string;
  line: number;
  confidence?: number;
  resolutionKind?: string;
}

export interface ParseResult {
  file: string;
  symbols: SymbolInfo[];
  imports: ImportInfo[];
  calls: CallInfo[];
  references: ReferenceInfo[];
  /** Whether tree-sitter detected syntax errors in this file */
  hasParseErrors: boolean;
  /** 0.0–1.0: how reliable this parse result is likely to be */
  parseConfidence: number;
  /** Package name extracted from package declaration (Java) */
  packageName?: string;
  /** Type references from fields/params/return types for supplemental dependency edges */
  typeReferences?: TypeRefInfo[];
}

/**
 * Interface that all language analyzers implement.
 */
export interface CodeAnalyzer {
  /** Supported file extensions (e.g., ['.java', '.kt']) */
  supportedExtensions: string[];

  /** Parse a single file and extract symbols, imports, calls */
  parse(filePath: string, content: string, rootDir: string): ParseResult;
}
