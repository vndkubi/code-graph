import Parser from 'tree-sitter';
import type { SyntaxNode } from 'tree-sitter';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type {
  CodeAnalyzer,
  ParseResult,
  SymbolInfo,
  ImportInfo,
  CallInfo,
  ReferenceInfo,
  TypeRefInfo,
  FieldAccessKind,
  FieldUsageInfo,
  SymbolKind,
  Visibility,
} from './base-analyzer.js';
import { detectLanguage, type SupportedLanguage } from './language-detector.js';
import { toRelativePath } from '../utils/path-guard.js';

const require = createRequire(import.meta.url);

// Grammar modules loaded lazily
const grammarLoaders: Partial<Record<SupportedLanguage, () => unknown>> = {
  java: () => require('tree-sitter-java'),
  typescript: () => {
    const tsGrammar = require('tree-sitter-typescript');
    return tsGrammar.typescript;
  },
  javascript: () => {
    // tree-sitter-typescript ships a JS grammar too; fall back to TS grammar for JSX
    try {
      const tsGrammar = require('tree-sitter-typescript');
      return tsGrammar.tsx;
    } catch {
      return undefined;
    }
  },
  python: () => require('tree-sitter-python'),
};

const loadedGrammars = new Map<SupportedLanguage, unknown>();
const javaSourceRootDiscoveryCache = new Map<string, string[]>();
const EXTERNAL_JAVA_ANNOTATION_CONSTANT_PATTERN = /@\w+(?:\s*\([\s\S]{0,300}\b[A-Z][A-Za-z0-9_]*\s*\.\s*[A-Z][A-Za-z0-9_]*\b)/;
const XCONTENT_BUILDER_FLUENT_METHODS = new Set([
  'array',
  'copyCurrentStructure',
  'endArray',
  'endObject',
  'field',
  'flush',
  'humanReadableField',
  'nullValue',
  'nullField',
  'rawField',
  'startArray',
  'startObject',
  'timestampFieldsFromUnixEpochMillis',
  'utf8Value',
  'value',
]);

interface JavaFieldInfo {
  name: string;
  ownerClass: string;
  fieldFqName: string;
  type?: string;
}

interface JavaTypeMembers {
  accessorsByClass: Map<string, Map<string, string>>;
  fieldsByClass: Map<string, Map<string, string>>;
  functionalParamTypesByClass: Map<string, Map<string, JavaMethodFunctionalSignature[]>>;
  superClassByClass: Map<string, string>;
}

interface JavaMethodFunctionalSignature {
  parameterCount: number;
  parameterTypes: Array<string[] | undefined>;
}

function javaFieldUsagesEnabled(): boolean {
  const value = String(process.env.CODEGRAPH_ENABLE_FIELD_USAGES ?? '').trim().toLowerCase();
  if (!value) return true;
  return value !== '0' && value !== 'false' && value !== 'no' && value !== 'off';
}

interface JavaFieldUsageContext {
  enclosingClass: string;
  enclosingSymbol: string;
  isConstructor: boolean;
  receiverTypes: Map<string, string>;
  shadowedNames: Set<string>;
  seen: Set<string>;
}

interface ScriptCallbackContext {
  callableSymbols: Set<string>;
  importedSymbols: Set<string>;
  classMethods: Map<string, Set<string>>;
}

function getGrammar(lang: SupportedLanguage): unknown | undefined {
  if (loadedGrammars.has(lang)) return loadedGrammars.get(lang);
  const loader = grammarLoaders[lang];
  if (!loader) return undefined;
  try {
    const grammar = loader();
    if (grammar) loadedGrammars.set(lang, grammar);
    return grammar;
  } catch {
    return undefined;
  }
}

/**
 * Tree-sitter based code analyzer supporting Java, TypeScript, Python.
 */
// Method/constructor bodies cannot contain class-level field declarations,
// imports, or endpoint annotations. Pruning them turns the Java pre-walks
// from whole-tree traversals into declaration-skeleton scans — significant
// because every node access crosses the JS/native tree-sitter boundary and
// unmarshalling dominates parse cost (measured ~66% of a large-file parse).
const JAVA_BODY_PRUNE_TYPES = new Set(['block', 'constructor_body', 'lambda_expression']);

// The external-Java lookup caches grow with every distinct imported class a
// worker encounters. Unbounded, a large monorepo (hadoop: 12k+ java files)
// drags most of the repo's type members into every parse worker — measured as
// multi-GB RSS growth during the parse phase. FIFO eviction keeps the hit
// rate for import clusters while bounding worst-case memory.
const EXTERNAL_JAVA_CACHE_MAX_ENTRIES = 512;

// Node types the call/reference extractor actually acts on. The cursor walk
// materializes a SyntaxNode ONLY for these; everything else advances via
// cursor.nodeType (a plain string) — no JS/native node unmarshalling, which
// the profiler showed was ~half of total parse time.
const CALL_EXTRACTION_TYPES = new Set([
  'field_access', 'identifier', 'member_expression', 'attribute',
  'method_declaration', 'constructor_declaration', 'lambda_expression',
  'arrow_function', 'function_expression', 'lambda',
  'object_creation_expression', 'method_invocation', 'method_reference',
  'call_expression', 'call',
]);

const LOCAL_VARIABLE_TYPES = new Set([
  'enhanced_for_statement', 'catch_formal_parameter', 'type_pattern',
  'instanceof_expression', 'resource', 'local_variable_declaration',
]);

function boundedCacheSet<K, V>(cache: Map<K, V>, key: K, value: V): void {
  if (cache.size >= EXTERNAL_JAVA_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}

export class TreeSitterAnalyzer implements CodeAnalyzer {
  readonly supportedExtensions = ['.java', '.ts', '.tsx', '.js', '.jsx', '.py'];
  private parser = new Parser();

  // Temporary accumulators reset on each parse() call (Java only)
  private parseTypeRefs: TypeRefInfo[] = [];
  private parseFieldUsages: FieldUsageInfo[] = [];
  private parsePackageName: string | undefined;
  private javaFieldsByClass = new Map<string, Map<string, JavaFieldInfo>>();
  private javaRawFieldTypesByClass = new Map<string, Map<string, string>>();
  private javaAccessorReturnsByClass = new Map<string, Map<string, string>>();
  private javaFunctionalParamTypesByClass = new Map<string, Map<string, JavaMethodFunctionalSignature[]>>();
  private javaOuterClassByClass = new Map<string, string>();
  private javaSuperClassByClass = new Map<string, string>();
  private javaStaticImports = new Map<string, Set<string>>();
  private javaStringConstants = new Map<string, string>();
  private externalJavaConstantCache = new Map<string, Map<string, string> | undefined>();
  private externalJavaTypeMembersCache = new Map<string, JavaTypeMembers | undefined>();
  private externalJavaClassLookupCache = new Map<string, JavaTypeMembers | undefined>();
  private currentJavaFilePath: string | undefined;
  private currentJavaRootDir: string | undefined;
  private currentJavaImports: string[] = [];
  private currentJavaSourceRoots: string[] = [];
  private scriptCallbackContext: ScriptCallbackContext | undefined;

  parse(filePath: string, content: string, rootDir: string): ParseResult {
    const lang = detectLanguage(filePath);
    const relPath = toRelativePath(filePath, rootDir);

    const emptyResult: ParseResult = {
      file: relPath,
      symbols: [],
      imports: [],
      calls: [],
      references: [],
      hasParseErrors: false,
      parseConfidence: 1.0,
    };

    if (!lang) return emptyResult;

    const grammar = getGrammar(lang);
    if (!grammar) return emptyResult;

    this.parser.setLanguage(grammar as Parameters<typeof this.parser.setLanguage>[0]);
    const parseOptions = treeSitterParseOptions(content.length);
    const tree = parseOptions
      ? this.parser.parse(content, undefined, parseOptions)
      : this.parser.parse(content);

    const hasParseErrors = tree.rootNode.hasError;
    // Penalise confidence for parse errors; also slightly reduce for very large files
    // where tree-sitter may miss deeply-nested constructs.
    const sizeKb = content.length / 1024;
    const sizePenalty = sizeKb > 200 ? 0.1 : sizeKb > 50 ? 0.05 : 0;
    const parseConfidence = hasParseErrors ? Math.max(0.4, 0.7 - sizePenalty) : Math.max(0.85, 1.0 - sizePenalty);

    // Reset Java-specific accumulators
    this.parseTypeRefs = [];
    this.parseFieldUsages = [];
    this.parsePackageName = undefined;
    this.javaFieldsByClass = new Map();
    this.javaRawFieldTypesByClass = new Map();
    this.javaAccessorReturnsByClass = new Map();
    this.javaFunctionalParamTypesByClass = new Map();
    this.javaOuterClassByClass = new Map();
    this.javaSuperClassByClass = new Map();
    this.javaStaticImports = new Map();
    this.javaStringConstants = new Map();
    this.currentJavaFilePath = lang === 'java' ? filePath : undefined;
    this.currentJavaRootDir = lang === 'java' ? rootDir : undefined;
    this.currentJavaImports = [];
    this.currentJavaSourceRoots = lang === 'java' ? this.javaSourceRootsFor(filePath, rootDir) : [];
    this.scriptCallbackContext = undefined;
    if (lang === 'typescript' || lang === 'javascript' || lang === 'python') {
      this.scriptCallbackContext = {
        callableSymbols: new Set<string>(),
        importedSymbols: new Set<string>(),
        classMethods: new Map<string, Set<string>>(),
      };
    }
    if (lang === 'java') {
      this.javaStringConstants = this.collectJavaStringConstants(tree.rootNode);
      this.currentJavaImports = this.collectJavaImportPaths(tree.rootNode);
      if (EXTERNAL_JAVA_ANNOTATION_CONSTANT_PATTERN.test(content)) {
        this.mergeExternalJavaStringConstants(tree.rootNode, filePath, rootDir, this.javaStringConstants);
      }
    }

    const symbols: SymbolInfo[] = [];
    const imports: ImportInfo[] = [];
    const calls: CallInfo[] = [];
    const references: ReferenceInfo[] = [];
    const lines = content.split('\n');

    this.extractNodes(tree.rootNode, lang, relPath, rootDir, lines, symbols, imports, calls, references);

    return {
      file: relPath,
      symbols,
      imports,
      calls,
      references,
      hasParseErrors,
      parseConfidence,
      packageName: this.parsePackageName,
      typeReferences: this.parseTypeRefs.length > 0 ? [...this.parseTypeRefs] : undefined,
      fieldUsages: this.parseFieldUsages.length > 0 ? [...this.parseFieldUsages] : undefined,
    };
  }

  private extractNodes(
    node: SyntaxNode,
    lang: SupportedLanguage,
    relPath: string,
    rootDir: string,
    lines: string[],
    symbols: SymbolInfo[],
    imports: ImportInfo[],
    calls: CallInfo[],
    references: ReferenceInfo[],
  ): void {
    switch (lang) {
      case 'java':
        this.extractJava(node, relPath, lines, symbols, imports, calls, references);
        break;
      case 'typescript':
      case 'javascript':
        this.extractTypeScript(node, relPath, lines, symbols, imports, calls, references);
        break;
      case 'python':
        this.extractPython(node, relPath, lines, symbols, imports, calls, references);
        break;
    }
  }

  // ─── Java ────────────────────────────────────────────────

  private extractJava(
    node: SyntaxNode,
    file: string,
    lines: string[],
    symbols: SymbolInfo[],
    imports: ImportInfo[],
    calls: CallInfo[],
    references: ReferenceInfo[],
    parentClass?: string,
  ): void {
    for (const child of node.children) {
      switch (child.type) {
        case 'package_declaration': {
          const nameNode = child.children.find(
            c => c.type === 'scoped_identifier' || c.type === 'identifier',
          );
          if (nameNode) this.parsePackageName = nameNode.text;
          break;
        }

        case 'import_declaration': {
          this.collectJavaStaticImport(child);
          const importPath = child.children
            .filter(c => c.type === 'scoped_identifier' || c.type === 'identifier')
            .map(c => c.text)
            .join('');
          if (importPath) {
            const parts = importPath.split('.');
            const symbolName = parts[parts.length - 1];
            imports.push({
              source: importPath,
              symbols: symbolName === '*' ? [] : [symbolName],
              file,
              line: child.startPosition.row + 1,
              isExternal: !importPath.startsWith('.'),
            });
          }
          break;
        }

        case 'class_declaration':
        case 'interface_declaration':
        case 'enum_declaration':
        case 'record_declaration':
        case 'annotation_type_declaration': {
          const nameNode = child.childForFieldName('name');
          if (nameNode) {
            const kind: SymbolKind = child.type === 'interface_declaration' ? 'interface'
              : child.type === 'enum_declaration' ? 'enum'
              : child.type === 'annotation_type_declaration' ? 'interface'  // @interface → interface
              : 'class';  // class_declaration & record_declaration → class

            const vis = this.getJavaVisibility(child);
            const annotations = this.getJavaAnnotations(child);
            const isStatic = this.isJavaStatic(child);

            // extends / implements
            let extendsName: string | undefined;
            let implementsNames: string[] | undefined;
            if (child.type === 'class_declaration') {
              const superclassNode = child.childForFieldName('superclass');
              extendsName = this.extractJavaTypeName(superclassNode) ?? undefined;
              const interfacesNode = child.childForFieldName('interfaces');
              implementsNames = this.extractJavaTypeList(interfacesNode);
            } else if (child.type === 'interface_declaration') {
              // Interface can extend multiple interfaces via "extends_interfaces" or "interfaces"
              const extendsNode = child.childForFieldName('extends_interfaces')
                ?? child.childForFieldName('interfaces');
              implementsNames = this.extractJavaTypeList(extendsNode);
            }

            const classHttpMeta = this.extractHttpAnnotationMeta(child);
            if (parentClass) {
              this.javaOuterClassByClass.set(nameNode.text, parentClass);
            }
            if (extendsName) {
              this.javaSuperClassByClass.set(nameNode.text, extendsName);
            }
            symbols.push({
              name: nameNode.text,
              kind,
              file,
              line: child.startPosition.row + 1,
              column: child.startPosition.column + 1,
              endLine: child.endPosition.row + 1,
              signature: this.getLineText(lines, child.startPosition.row).trim(),
              visibility: vis,
              module: this.getJavaModule(file),
              parent: parentClass,
              packageName: this.parsePackageName,
              annotations: annotations.length > 0 ? annotations : undefined,
              isStatic: isStatic || undefined,
              extends: extendsName,
              implements: implementsNames && implementsNames.length > 0 ? implementsNames : undefined,
              frameworkMeta: Object.keys(classHttpMeta).length > 0 ? classHttpMeta : undefined,
            });

            // Recurse into body with class context
            const body = child.childForFieldName('body');
            if (body) {
              this.collectJavaClassFields(body, nameNode.text);
              this.collectJavaClassAccessors(child, body, nameNode.text);
              this.extractJava(body, file, lines, symbols, imports, calls, references, nameNode.text);
            } else if (child.type === 'record_declaration') {
              this.collectJavaClassAccessors(child, undefined, nameNode.text);
            }
          }
          break;
        }

        case 'field_declaration': {
          const vis = this.getJavaVisibility(child);
          const annotations = this.getJavaAnnotations(child);
          const isStatic = this.isJavaStatic(child);

          // Extract field type for type-reference tracking
          const typeNode = child.childForFieldName('type');
          const fieldTypeName = this.extractJavaTypeName(typeNode);
          const fieldLine = child.startPosition.row + 1;

          // A field_declaration may declare multiple variables: int a, b;
          for (const c of child.children) {
            if (c.type === 'variable_declarator') {
              const nameNode = c.childForFieldName('name') ?? c.children.find(n => n.type === 'identifier');
              if (nameNode) {
                symbols.push({
                  name: nameNode.text,
                  kind: 'field',
                  file,
                  line: fieldLine,
                  column: c.startPosition.column + 1,
                  endLine: child.endPosition.row + 1,
                  signature: this.getLineText(lines, child.startPosition.row).trim(),
                  visibility: vis,
                  module: this.getJavaModule(file),
                  parent: parentClass,
                  packageName: this.parsePackageName,
                  annotations: annotations.length > 0 ? annotations : undefined,
                  isStatic: isStatic || undefined,
                  returnType: fieldTypeName ?? undefined,  // reuse returnType for field type
                });

                // Track non-primitive type references for dependency resolution
                if (fieldTypeName && this.isReferenceType(fieldTypeName)) {
                  this.parseTypeRefs.push({
                    file,
                    referencedType: fieldTypeName,
                    context: 'field',
                    line: fieldLine,
                  });
                }
              }
            }
          }
          break;
        }

        case 'method_declaration':
        case 'constructor_declaration': {
          const nameNode = child.childForFieldName('name') ?? child.children.find(c => c.type === 'identifier');
          if (nameNode) {
            const vis = this.getJavaVisibility(child);
            const annotations = this.getJavaAnnotations(child);
            const isStatic = this.isJavaStatic(child);
            const methodName = parentClass ? `${parentClass}.${nameNode.text}` : nameNode.text;

            // Return type (void for constructors)
            const returnTypeNode = child.childForFieldName('type');
            const returnType = this.extractJavaTypeName(returnTypeNode);

            // Parameter types + collect parameter-level annotations (e.g. @Observes, @FormParam)
            const paramsNode = child.childForFieldName('parameters');
            const parameterTypes = this.extractMethodParamTypes(paramsNode, file);
            const paramAnnotations = this.getJavaParameterAnnotations(paramsNode);
            // Merge parameter annotations (e.g. @Observes) into method annotations
            const allAnnotations = [...new Set([...annotations, ...paramAnnotations])];

            const methodHttpMeta = this.extractHttpAnnotationMeta(child);
            symbols.push({
              name: nameNode.text,
              kind: 'method',
              file,
              line: child.startPosition.row + 1,
              column: child.startPosition.column + 1,
              endLine: child.endPosition.row + 1,
              signature: this.getSignatureLine(lines, child.startPosition.row),
              visibility: vis,
              module: this.getJavaModule(file),
              parent: parentClass,
              packageName: this.parsePackageName,
              annotations: allAnnotations.length > 0 ? allAnnotations : undefined,
              isStatic: isStatic || undefined,
              returnType: returnType ?? undefined,
              parameterTypes: parameterTypes.length > 0 ? parameterTypes : undefined,
              frameworkMeta: Object.keys(methodHttpMeta).length > 0 ? methodHttpMeta : undefined,
            });

            // Track non-primitive return type
            if (returnType && this.isReferenceType(returnType)) {
              this.parseTypeRefs.push({
                file,
                referencedType: returnType,
                context: 'return',
                line: child.startPosition.row + 1,
              });
            }

            // Extract calls within the method body
            const body = child.childForFieldName('body');
            if (body) {
              const receiverTypes = this.extractMethodParamTypeMap(paramsNode);
              const shadowedNames = this.extractJavaParameterNames(paramsNode);
              this.collectJavaLocalVariableTypes(body, receiverTypes, file, shadowedNames, parentClass);
              const fieldUsageContext = javaFieldUsagesEnabled() && parentClass
                ? this.javaFieldUsageContext(parentClass, methodName, child.type === 'constructor_declaration', receiverTypes, shadowedNames)
                : undefined;
              this.extractCallsFromNode(body, file, lines, calls, references, methodName, receiverTypes, fieldUsageContext, parentClass);
            }
          }
          break;
        }

        default:
          // Recurse for other nodes
          this.extractJava(child, file, lines, symbols, imports, calls, references, parentClass);
          break;
      }
    }
  }

  // ─── Java helpers ─────────────────────────────────────────

  /**
   * Extract annotation names from method parameter modifiers.
   * Handles CDI @Observes, JAX-RS @PathParam/@FormParam/@QueryParam/@BeanParam, etc.
   * These appear inside formal_parameter → modifiers, not on the method itself.
   */
  private collectJavaClassFields(body: SyntaxNode, className: string): void {
    const fields = new Map<string, JavaFieldInfo>();
    const rawFieldTypes = new Map<string, string>();
    const packagePrefix = this.parsePackageName ? `${this.parsePackageName}.` : '';
    for (const child of body.children) {
      if (child.type !== 'field_declaration') continue;
      const fieldType = this.extractJavaTypeName(child.childForFieldName('type')) ?? undefined;
      const rawFieldType = this.extractJavaTypeText(child.childForFieldName('type')) ?? undefined;
      for (const declarator of child.children.filter(c => c.type === 'variable_declarator')) {
        const nameNode = declarator.childForFieldName('name') ?? declarator.children.find(c => c.type === 'identifier');
        if (!nameNode) continue;
        fields.set(nameNode.text, {
          name: nameNode.text,
          ownerClass: className,
          fieldFqName: `${packagePrefix}${className}.${nameNode.text}`,
          type: fieldType,
        });
        if (rawFieldType) rawFieldTypes.set(nameNode.text, rawFieldType);
      }
    }
    this.javaFieldsByClass.set(className, fields);
    this.javaRawFieldTypesByClass.set(className, rawFieldTypes);
  }

  private collectJavaClassAccessors(
    classNode: SyntaxNode,
    body: SyntaxNode | undefined,
    className: string,
  ): void {
    const accessors = new Map<string, string>();
    const functionalParamTypes = new Map<string, JavaMethodFunctionalSignature[]>();
    const classAnnotations = new Set(this.getJavaAnnotations(classNode));
    const classHasGetter = classAnnotations.has('Getter') || classAnnotations.has('Data');

    if (body) {
      for (const child of body.children) {
        if (child.type === 'method_declaration') {
          const nameNode = child.childForFieldName('name') ?? child.children.find(c => c.type === 'identifier');
          const returnType = this.extractJavaTypeText(child.childForFieldName('type'));
          if (nameNode && returnType) accessors.set(nameNode.text, returnType);
          if (nameNode) this.addJavaMethodFunctionalSignature(functionalParamTypes, nameNode.text, child.childForFieldName('parameters'));
        }

        if (child.type === 'field_declaration') {
          const fieldType = this.extractJavaTypeText(child.childForFieldName('type'));
          if (!fieldType) continue;
          const fieldAnnotations = new Set(this.getJavaAnnotations(child));
          const fieldHasGetter = classHasGetter || fieldAnnotations.has('Getter') || fieldAnnotations.has('Data');
          if (!fieldHasGetter) continue;
          for (const declarator of child.children.filter(c => c.type === 'variable_declarator')) {
            const nameNode = declarator.childForFieldName('name') ?? declarator.children.find(c => c.type === 'identifier');
            if (!nameNode) continue;
            accessors.set(javaBeanGetterName(nameNode.text, fieldType), fieldType);
          }
        }
      }
    }

    if (classNode.type === 'record_declaration') {
      const paramsNode = classNode.childForFieldName('parameters')
        ?? classNode.namedChildren.find(child => child.type === 'formal_parameters');
      if (paramsNode) {
        for (const param of paramsNode.namedChildren) {
          if (param.type !== 'formal_parameter' && param.type !== 'spread_parameter') continue;
          const typeName = this.extractJavaTypeText(param.childForFieldName('type'));
          const nameNode = param.childForFieldName('name')
            ?? [...param.namedChildren].reverse().find(node => node.type === 'identifier');
          if (typeName && nameNode) accessors.set(nameNode.text, typeName);
        }
      }
    }

    this.javaAccessorReturnsByClass.set(className, accessors);
    this.javaFunctionalParamTypesByClass.set(className, functionalParamTypes);
  }

  private extractJavaParameterNames(paramsNode: SyntaxNode | null | undefined): Set<string> {
    const names = new Set<string>();
    if (!paramsNode) return names;
    for (const child of paramsNode.children) {
      if (child.type !== 'formal_parameter' && child.type !== 'spread_parameter') continue;
      const nameNode = child.childForFieldName('name')
        ?? [...child.namedChildren].reverse().find(node => node.type === 'identifier');
      if (nameNode) names.add(nameNode.text);
    }
    return names;
  }

  private resolveJavaFieldAccess(
    fieldName: string,
    receiverText: string | undefined,
    enclosingClass: string,
    receiverTypes: Map<string, string>,
  ): { field?: JavaFieldInfo; confidence: number; resolutionKind: string } {
    if (receiverText === 'this' || receiverText === 'super') {
      const field = this.javaFieldsByClass.get(enclosingClass)?.get(fieldName) ?? {
        name: fieldName,
        ownerClass: enclosingClass,
        fieldFqName: `${this.parsePackageName ? `${this.parsePackageName}.` : ''}${enclosingClass}.${fieldName}`,
      };
      return { field, confidence: 0.95, resolutionKind: `${receiverText}-field` };
    }

    const receiverType = receiverText ? resolveReceiverType(receiverText, receiverTypes) : undefined;
    if (receiverType) {
      return {
        field: {
          name: fieldName,
          ownerClass: receiverType,
          fieldFqName: `${receiverType}.${fieldName}`,
        },
        confidence: 0.65,
        resolutionKind: 'receiver-type-field',
      };
    }

    if (receiverText && /^[A-Z]/.test(receiverText)) {
      return {
        field: {
          name: fieldName,
          ownerClass: receiverText,
          fieldFqName: `${receiverText}.${fieldName}`,
        },
        confidence: 0.7,
        resolutionKind: 'static-or-type-field',
      };
    }

    return { confidence: 0.35, resolutionKind: 'receiver-unresolved-field' };
  }

  private javaFieldUsageContext(
    enclosingClass: string,
    enclosingSymbol: string,
    isConstructor: boolean,
    receiverTypes: Map<string, string>,
    shadowedNames: Set<string>,
  ): JavaFieldUsageContext | undefined {
    const classFields = this.javaFieldsByClass.get(enclosingClass);
    if (!classFields || classFields.size === 0) return undefined;
    return {
      enclosingClass,
      enclosingSymbol,
      isConstructor,
      receiverTypes,
      shadowedNames,
      seen: new Set(),
    };
  }

  private getJavaParameterAnnotations(paramsNode: SyntaxNode | null | undefined): string[] {
    if (!paramsNode) return [];
    const names: string[] = [];
    for (const param of paramsNode.children) {
      if (param.type !== 'formal_parameter' && param.type !== 'spread_parameter') continue;
      for (const mod of param.children) {
        if (mod.type !== 'modifiers') continue;
        for (const ann of mod.children) {
          if (ann.type !== 'annotation' && ann.type !== 'marker_annotation') continue;
          const nameNode = ann.childForFieldName('name');
          if (!nameNode) continue;
          const text = nameNode.text;
          const simpleName = text.includes('.') ? text.substring(text.lastIndexOf('.') + 1) : text;
          if (!names.includes(simpleName)) names.push(simpleName);
        }
      }
    }
    return names;
  }

  private getJavaAnnotations(node: SyntaxNode): string[] {
    const names: string[] = [];
    for (const child of node.children) {
      if (child.type === 'modifiers') {
        for (const mod of child.children) {
          if (mod.type === 'annotation' || mod.type === 'marker_annotation') {
            const nameNode = mod.childForFieldName('name');
            if (nameNode) {
              // Take only the simple name (strip package prefix if any)
              const text = nameNode.text;
              const simpleName = text.includes('.') ? text.substring(text.lastIndexOf('.') + 1) : text;
              names.push(simpleName);
            }
          }
        }
      }
    }
    return names;
  }

  private isJavaStatic(node: SyntaxNode): boolean {
    for (const child of node.children) {
      if (child.type === 'modifiers' && /\bstatic\b/.test(child.text)) return true;
    }
    return false;
  }

  /** Extract a simple type name from a tree-sitter type node. */
  private extractJavaTypeName(node: SyntaxNode | null | undefined): string | null {
    if (!node) return null;
    switch (node.type) {
      case 'type_identifier':
        return node.text;
      case 'generic_type': {
        // e.g. List<User> → "List"
        const base = node.namedChildren.find(c => c.type === 'type_identifier' || c.type === 'scoped_type_identifier');
        return base ? this.extractJavaTypeName(base) : null;
      }
      case 'array_type': {
        // e.g. User[] → "User"
        const element = node.childForFieldName('element') ?? node.namedChildren[0];
        return this.extractJavaTypeName(element);
      }
      case 'scoped_type_identifier': {
        // e.g. java.util.List → take last identifier
        const last = [...node.namedChildren].reverse().find(c => c.type === 'type_identifier');
        return last?.text ?? null;
      }
      case 'void_type':
        return 'void';
      // Primitives — not reference types, skip for dependency tracking
      case 'integral_type':
      case 'floating_point_type':
      case 'boolean_type':
        return node.text;
      // Wrapper nodes — unwrap to inner type
      case 'superclass': {
        // "extends TypeName" — find the actual type node
        const typeChild = node.namedChildren.find(c =>
          c.type === 'type_identifier' || c.type === 'generic_type' || c.type === 'scoped_type_identifier'
        );
        return typeChild ? this.extractJavaTypeName(typeChild) : null;
      }
      case 'interface_type': {
        // single interface_type wrapper
        const typeChild = node.namedChildren.find(c =>
          c.type === 'type_identifier' || c.type === 'generic_type' || c.type === 'scoped_type_identifier'
        );
        return typeChild ? this.extractJavaTypeName(typeChild) : null;
      }
      default:
        return node.text || null;
    }
  }

  private extractJavaTypeText(node: SyntaxNode | null | undefined): string | undefined {
    if (!node) return undefined;
    return normalizeJavaTypeText(node.text);
  }

  /**
   * Extract a list of type names from a super_interfaces / extends_interfaces /
   * interface_type_list node (Java implements / extends clause).
   */
  private extractJavaTypeList(node: SyntaxNode | null | undefined): string[] {
    if (!node) return [];

    // Recurse through outer wrapper nodes
    if (node.type === 'super_interfaces' || node.type === 'extends_interfaces') {
      const result: string[] = [];
      for (const child of node.namedChildren) {
        result.push(...this.extractJavaTypeList(child));
      }
      return result;
    }

    if (node.type === 'interface_type_list') {
      return node.namedChildren
        .map(c => this.extractJavaTypeName(c))
        .filter((n): n is string => n !== null && n !== '' && n !== ',' && n !== 'implements' && n !== 'extends');
    }

    if (node.type === 'interface_type') {
      const name = this.extractJavaTypeName(node);
      return name ? [name] : [];
    }

    // Fallback: iterate named children
    return node.namedChildren
      .map(c => this.extractJavaTypeName(c))
      .filter((n): n is string => n !== null && n !== '' && n !== ',' && n !== 'implements' && n !== 'extends');
  }

  /**
   * Extract HTTP path from a node's annotation arguments.
   * e.g. @GetMapping("/api/notes/{id}") → "/api/notes/{id}"
   * Returns undefined if no HTTP mapping annotation with a path is found.
   */
  private collectJavaStringConstants(root: SyntaxNode): Map<string, string> {
    const candidates: Array<{ name: string; value: SyntaxNode }> = [];

    const visit = (node: SyntaxNode): void => {
      if (node.type === 'field_declaration') {
        const modifiers = node.children.find(c => c.type === 'modifiers')?.text ?? '';
        const typeName = this.extractJavaTypeName(node.childForFieldName('type'));
        if (typeName === 'String' && /\bfinal\b/.test(modifiers)) {
          for (const declarator of node.children.filter(c => c.type === 'variable_declarator')) {
            const nameNode = declarator.childForFieldName('name') ?? declarator.children.find(c => c.type === 'identifier');
            const valueNode = declarator.childForFieldName('value');
            if (nameNode && valueNode) candidates.push({ name: nameNode.text, value: valueNode });
          }
        }
      }
      for (const child of node.children) {
        if (!JAVA_BODY_PRUNE_TYPES.has(child.type)) visit(child);
      }
    };
    visit(root);

    const constants = new Map<string, string>();
    for (let pass = 0; pass < 4; pass++) {
      let changed = false;
      for (const candidate of candidates) {
        if (constants.has(candidate.name)) continue;
        const value = this.evaluateJavaStringExpression(candidate.value, constants);
        if (value !== undefined) {
          constants.set(candidate.name, value);
          changed = true;
        }
      }
      if (!changed) break;
    }
    return constants;
  }

  private mergeExternalJavaStringConstants(
    root: SyntaxNode,
    filePath: string,
    rootDir: string,
    constants: Map<string, string>,
  ): void {
    const classNames = this.collectJavaAnnotationConstantClassNames(root);
    if (classNames.size === 0) return;

    const imports = this.collectJavaImportPaths(root);
    const currentDir = path.dirname(filePath);
    const sourceRoots = this.javaSourceRootsFor(filePath, rootDir);

    for (const className of classNames) {
      for (const candidatePath of this.javaConstantCandidatePaths(className, currentDir, sourceRoots, imports)) {
        if (path.resolve(candidatePath) === path.resolve(filePath)) continue;
        const externalConstants = this.readJavaStringConstantsFromFile(candidatePath);
        if (!externalConstants) continue;
        for (const [name, value] of externalConstants) {
          constants.set(`${className}.${name}`, value);
          if (!constants.has(name)) constants.set(name, value);
        }
        break;
      }
    }
  }

  private collectJavaAnnotationConstantClassNames(root: SyntaxNode): Set<string> {
    const classNames = new Set<string>();
    const visit = (node: SyntaxNode): void => {
      if (node.type === 'annotation') {
        const argsNode = node.childForFieldName('arguments');
        if (argsNode) {
          const regex = /\b([A-Z][A-Za-z0-9_]*)\s*\.\s*[A-Z][A-Za-z0-9_]*\b/g;
          let match: RegExpExecArray | null;
          while ((match = regex.exec(argsNode.text)) !== null) {
            if (match[1]) classNames.add(match[1]);
          }
        }
      }
      for (const child of node.children) {
        if (!JAVA_BODY_PRUNE_TYPES.has(child.type)) visit(child);
      }
    };
    visit(root);
    return classNames;
  }

  private collectJavaImportPaths(root: SyntaxNode): string[] {
    // Java import declarations are direct children of the compilation unit —
    // no recursion needed, and each avoided node access saves a native call.
    const imports: string[] = [];
    for (const child of root.children) {
      if (child.type !== 'import_declaration') continue;
      const match = child.text.match(/^import\s+(?:static\s+)?([\w.*]+)\s*;/);
      if (match?.[1]) imports.push(match[1]);
    }
    return imports;
  }

  private javaSourceRootsFor(filePath: string, rootDir: string): string[] {
    const roots = new Set<string>();
    const normalized = filePath.replace(/\\/g, '/');
    const moduleRoots = new Set<string>();
    const markers = [
      '/src/main/java/',
      '/src/test/java/',
      '/src/integration-test/java/',
      '/src/java/',
    ];
    for (const marker of markers) {
      const index = normalized.indexOf(marker);
      if (index >= 0) {
        const moduleRoot = filePath.slice(0, index);
        moduleRoots.add(moduleRoot);
        for (const siblingMarker of markers) {
          const candidateRoot = path.join(moduleRoot, ...siblingMarker.split('/').filter(Boolean));
          if (fs.existsSync(candidateRoot)) roots.add(candidateRoot);
        }
      }
    }
    for (const moduleRoot of moduleRoots) {
      const repoRoot = path.dirname(moduleRoot);
      if (!isLikelyJavaRepoRoot(repoRoot)) continue;
      for (const discoveredRoot of discoverJavaSourceRootsUnder(repoRoot, 2)) roots.add(discoveredRoot);
    }
    roots.add(rootDir);
    return [...roots];
  }

  private javaConstantCandidatePaths(
    className: string,
    currentDir: string,
    sourceRoots: string[],
    imports: string[],
  ): string[] {
    const candidates = new Set<string>();
    candidates.add(path.join(currentDir, `${className}.java`));
    if (this.parsePackageName) {
      const packageParts = this.parsePackageName.split('.').filter(Boolean);
      for (const sourceRoot of sourceRoots) {
        candidates.add(path.join(sourceRoot, ...packageParts, `${className}.java`));
      }
    }

    for (const importPath of imports) {
      const parts = importPath.split('.').filter(Boolean);
      if (parts[parts.length - 1] === className) {
        for (const sourceRoot of sourceRoots) {
          candidates.add(path.join(sourceRoot, ...parts) + '.java');
        }
      }
      if (parts.length >= 2 && parts[parts.length - 2] === className) {
        const classParts = parts.slice(0, -1);
        for (const sourceRoot of sourceRoots) {
          candidates.add(path.join(sourceRoot, ...classParts) + '.java');
        }
      }
    }

    return [...candidates];
  }

  private readJavaStringConstantsFromFile(filePath: string): Map<string, string> | undefined {
    const absolute = path.resolve(filePath);
    if (this.externalJavaConstantCache.has(absolute)) return this.externalJavaConstantCache.get(absolute);

    let constants: Map<string, string> | undefined;
    try {
      const stat = fs.statSync(absolute);
      if (stat.isFile() && stat.size <= 512 * 1024) {
        const content = fs.readFileSync(absolute, 'utf8');
        const tree = this.parser.parse(content, undefined, treeSitterParseOptions(content.length));
        constants = this.collectJavaStringConstants(tree.rootNode);
      }
    } catch {
      constants = undefined;
    }

    boundedCacheSet(this.externalJavaConstantCache, absolute, constants);
    return constants;
  }

  private readJavaTypeMembersFromFile(filePath: string): JavaTypeMembers | undefined {
    const absolute = path.resolve(filePath);
    if (this.externalJavaTypeMembersCache.has(absolute)) return this.externalJavaTypeMembersCache.get(absolute);

    let members: JavaTypeMembers | undefined;
    try {
      const stat = fs.statSync(absolute);
      if (stat.isFile() && stat.size <= 768 * 1024) {
        const content = fs.readFileSync(absolute, 'utf8');
        const tree = this.parser.parse(content, undefined, treeSitterParseOptions(content.length));
        members = this.collectJavaTypeMembers(tree.rootNode);
      }
    } catch {
      members = undefined;
    }

    boundedCacheSet(this.externalJavaTypeMembersCache, absolute, members);
    return members;
  }

  private collectJavaTypeMembers(root: SyntaxNode): JavaTypeMembers {
    const accessorsByClass = new Map<string, Map<string, string>>();
    const fieldsByClass = new Map<string, Map<string, string>>();
    const functionalParamTypesByClass = new Map<string, Map<string, JavaMethodFunctionalSignature[]>>();
    const superClassByClass = new Map<string, string>();

    const visit = (node: SyntaxNode): void => {
      for (const child of node.children) {
        if (
          child.type === 'class_declaration'
          || child.type === 'interface_declaration'
          || child.type === 'record_declaration'
        ) {
          const nameNode = child.childForFieldName('name');
          if (!nameNode) continue;
          const className = nameNode.text;
          const superclassNode = child.type === 'class_declaration'
            ? child.childForFieldName('superclass')
            : undefined;
          const superclassName = this.extractJavaTypeName(superclassNode);
          if (superclassName) superClassByClass.set(className, superclassName);
          const fields = new Map<string, string>();
          const accessors = new Map<string, string>();
          const functionalParamTypes = new Map<string, JavaMethodFunctionalSignature[]>();
          const classAnnotations = new Set(this.getJavaAnnotations(child));
          const classHasGetter = classAnnotations.has('Getter') || classAnnotations.has('Data');
          const body = child.childForFieldName('body');

          if (body) {
            for (const member of body.children) {
              if (member.type === 'field_declaration') {
                const fieldType = this.extractJavaTypeText(member.childForFieldName('type'));
                if (!fieldType) continue;
                const fieldAnnotations = new Set(this.getJavaAnnotations(member));
                const fieldHasGetter = classHasGetter || fieldAnnotations.has('Getter') || fieldAnnotations.has('Data');
                for (const declarator of member.children.filter(c => c.type === 'variable_declarator')) {
                  const fieldName = declarator.childForFieldName('name')?.text
                    ?? declarator.children.find(c => c.type === 'identifier')?.text;
                  if (!fieldName) continue;
                  fields.set(fieldName, fieldType);
                  if (fieldHasGetter) accessors.set(javaBeanGetterName(fieldName, fieldType), fieldType);
                }
              } else if (member.type === 'method_declaration') {
                const methodName = member.childForFieldName('name')?.text
                  ?? member.children.find(c => c.type === 'identifier')?.text;
                const returnType = this.extractJavaTypeText(member.childForFieldName('type'));
                if (methodName && returnType) accessors.set(methodName, returnType);
                if (methodName) this.addJavaMethodFunctionalSignature(functionalParamTypes, methodName, member.childForFieldName('parameters'));
              }
            }
          }

          if (child.type === 'record_declaration') {
            const paramsNode = child.childForFieldName('parameters')
              ?? child.namedChildren.find(named => named.type === 'formal_parameters');
            if (paramsNode) {
              for (const param of paramsNode.namedChildren) {
                if (param.type !== 'formal_parameter' && param.type !== 'spread_parameter') continue;
                const fieldType = this.extractJavaTypeText(param.childForFieldName('type'));
                const fieldName = param.childForFieldName('name')?.text
                  ?? [...param.namedChildren].reverse().find(named => named.type === 'identifier')?.text;
                if (!fieldType || !fieldName) continue;
                fields.set(fieldName, fieldType);
                accessors.set(fieldName, fieldType);
              }
            }
          }

          fieldsByClass.set(className, fields);
          accessorsByClass.set(className, accessors);
          functionalParamTypesByClass.set(className, functionalParamTypes);
          if (body) visit(body);
          continue;
        }
        if (!JAVA_BODY_PRUNE_TYPES.has(child.type)) visit(child);
      }
    };

    visit(root);
    return { accessorsByClass, fieldsByClass, functionalParamTypesByClass, superClassByClass };
  }

  private resolveJavaAccessorReturnType(receiverType: string, methodName: string): string | undefined {
    const className = simpleTypeName(receiverType);
    const local = this.javaAccessorReturnsByClass.get(className)?.get(methodName);
    if (local) return local;
    return this.resolveExternalJavaClassMemberType(className, members => members.accessorsByClass.get(className)?.get(methodName));
  }

  private resolveJavaRawFieldType(receiverType: string, fieldName: string): string | undefined {
    const className = simpleTypeName(receiverType);
    const local = this.javaRawFieldTypesByClass.get(className)?.get(fieldName);
    if (local) return local;
    return this.resolveExternalJavaClassMemberType(className, members => members.fieldsByClass.get(className)?.get(fieldName));
  }

  private resolveJavaFieldTypeFromHierarchy(className: string | undefined, fieldName: string): string | undefined {
    const seenClasses = new Set<string>();
    const visit = (candidateClass: string | undefined): string | undefined => {
      if (!candidateClass || seenClasses.has(candidateClass)) return undefined;
      seenClasses.add(candidateClass);

      const localType = this.javaFieldsByClass.get(candidateClass)?.get(fieldName)?.type;
      if (localType) return localType;

      const externalFields = this.resolveExternalJavaClassMembers(candidateClass, members => members.fieldsByClass.get(candidateClass));
      const externalType = externalFields?.get(fieldName);
      if (externalType) return simpleTypeName(externalType);

      return visit(this.javaSuperClassByClass.get(candidateClass))
        ?? visit(this.javaOuterClassByClass.get(candidateClass));
    };

    return visit(className);
  }

  private resolveExternalJavaClassMemberType(
    className: string,
    pick: (members: JavaTypeMembers) => string | undefined,
  ): string | undefined {
    return this.resolveExternalJavaClassMembers(className, pick);
  }

  private resolveExternalJavaClassMembers<T>(
    className: string,
    pick: (members: JavaTypeMembers) => T | undefined,
  ): T | undefined {
    const currentFilePath = this.currentJavaFilePath;
    if (!currentFilePath) return undefined;
    const currentDir = path.dirname(currentFilePath);
    const cacheKey = [
      currentDir,
      this.parsePackageName ?? '',
      className,
      this.currentJavaSourceRoots.join('|'),
      this.currentJavaImports.join('|'),
    ].join('\0');
    if (this.externalJavaClassLookupCache.has(cacheKey)) {
      const cached = this.externalJavaClassLookupCache.get(cacheKey);
      return cached ? pick(cached) : undefined;
    }

    const candidatePaths = this.javaConstantCandidatePaths(
      className,
      currentDir,
      this.currentJavaSourceRoots,
      this.currentJavaImports,
    );
    for (const candidatePath of candidatePaths) {
      if (path.resolve(candidatePath) === path.resolve(currentFilePath)) continue;
      const members = this.readJavaTypeMembersFromFile(candidatePath);
      if (!members || !javaTypeMembersContainClass(members, className)) continue;
      boundedCacheSet(this.externalJavaClassLookupCache, cacheKey, members);
      return pick(members);
    }
    boundedCacheSet(this.externalJavaClassLookupCache, cacheKey, undefined);
    return undefined;
  }

  private extractHttpAnnotationMeta(node: SyntaxNode): Record<string, string> {
    const HTTP_ANNOTATIONS = new Set([
      // Spring MVC
      'RequestMapping', 'GetMapping', 'PostMapping', 'PutMapping', 'DeleteMapping', 'PatchMapping',
      // JAX-RS / Jakarta MVC
      'Path', 'ApplicationPath',
      // Servlet
      'WebServlet', 'WebFilter',
      // WebSocket
      'ServerEndpoint',
    ]);

    // JPA/Jakarta persistence annotations whose `name`/`value` argument is the
    // PHYSICAL database identifier (table or column). Capturing it lets a developer
    // who only has the DB schema — no DB access, just the Java source — find the
    // entity/field by its physical name even when it differs from the Java name
    // (e.g. @Table(name="quiz_answer") on class Answer, @Column(name="type")).
    const JPA_NAME_ANNOTATIONS = new Set([
      'Table', 'Entity', 'Column', 'JoinColumn', 'SecondaryTable', 'CollectionTable',
    ]);

    const meta: Record<string, string> = {};
    for (const child of node.children) {
      if (child.type !== 'modifiers') continue;
      for (const mod of child.children) {
        if (mod.type !== 'annotation') continue;
        const nameNode = mod.childForFieldName('name');
        if (!nameNode) continue;
        const rawName = nameNode.text;
        const simpleName = rawName.includes('.') ? rawName.substring(rawName.lastIndexOf('.') + 1) : rawName;

        if (JPA_NAME_ANNOTATIONS.has(simpleName)) {
          const argsNode = mod.childForFieldName('arguments');
          const allowPositional = simpleName === 'Table' || simpleName === 'Entity';
          const dbName = argsNode ? this.extractNamedAnnotationArgument(argsNode, 'name', allowPositional) : undefined;
          if (dbName) meta['dbName'] = dbName;
          continue;
        }

        if (!HTTP_ANNOTATIONS.has(simpleName)) continue;

        const impliedMethod = this.httpMethodForAnnotation(simpleName);
        if (impliedMethod) meta['httpMethod'] = impliedMethod;

        const argsNode = mod.childForFieldName('arguments');
        if (argsNode) {
          const path = this.extractFirstStringArgument(argsNode);
          if (path !== undefined) {
            meta['path'] = path;
          } else if (this.hasPathLikeAnnotationArgument(argsNode)) {
            meta['pathResolution'] = 'partial';
            meta['pathResolutionReason'] = `Could not resolve ${simpleName} path expression: ${argsNode.text}`;
          }
          const requestMethod = this.extractRequestMappingMethod(argsNode);
          if (requestMethod) meta['httpMethod'] = requestMethod;
        }
      }
    }
    return meta;
  }

  private httpMethodForAnnotation(annotationName: string): string | undefined {
    switch (annotationName) {
      case 'GetMapping':
      case 'GET':
        return 'GET';
      case 'PostMapping':
      case 'POST':
        return 'POST';
      case 'PutMapping':
      case 'PUT':
        return 'PUT';
      case 'DeleteMapping':
      case 'DELETE':
        return 'DELETE';
      case 'PatchMapping':
      case 'PATCH':
        return 'PATCH';
      case 'HEAD':
        return 'HEAD';
      case 'OPTIONS':
        return 'OPTIONS';
      default:
        return undefined;
    }
  }

  /** Extract the first string literal value from annotation_argument_list. */
  private extractFirstStringArgument(argsNode: SyntaxNode): string | undefined {
    for (const child of argsNode.namedChildren) {
      // Direct string: @GetMapping("/api")
      const direct = this.evaluateJavaStringExpression(child, this.javaStringConstants);
      if (direct !== undefined) return direct;
      // Named pair: @RequestMapping(value = "/api"), @WebServlet(urlPatterns = "/foo")
      if (child.type === 'element_value_pair') {
        const key = child.childForFieldName('key')?.text;
        if (key === 'value' || key === 'path' || key === 'urlPatterns') {
          const val = child.childForFieldName('value');
          const resolved = val ? this.evaluateJavaStringExpression(val, this.javaStringConstants) : undefined;
          if (resolved !== undefined) return resolved;
          if (val?.type === 'array_initializer' || val?.type === 'element_value_array_initializer') {
            for (const item of val.namedChildren) {
              const arrayValue = this.evaluateJavaStringExpression(item, this.javaStringConstants);
              if (arrayValue !== undefined) return arrayValue;
            }
          }
        }
      }
    }
    // Last resort: first string_literal anywhere under args
    const anyStr = argsNode.namedChildren.find(c => c.type === 'string_literal');
    return anyStr ? this.unquoteJavaString(anyStr.text) : undefined;
  }

  /**
   * Extract a named string argument from an annotation, e.g. the `name` of
   * @Table(name = "quiz_answer") or @Column(name = "type"). When allowPositional
   * is set (single-value annotations like @Table("t")/@Entity("E")), falls back
   * to the first positional string literal.
   */
  private extractNamedAnnotationArgument(argsNode: SyntaxNode, key: string, allowPositional: boolean): string | undefined {
    for (const child of argsNode.namedChildren) {
      if (child.type !== 'element_value_pair') continue;
      if (child.childForFieldName('key')?.text !== key) continue;
      const val = child.childForFieldName('value');
      const resolved = val ? this.evaluateJavaStringExpression(val, this.javaStringConstants) : undefined;
      if (resolved !== undefined) return resolved;
    }
    if (allowPositional) {
      const direct = argsNode.namedChildren.find(c => c.type === 'string_literal');
      if (direct) return this.unquoteJavaString(direct.text);
    }
    return undefined;
  }

  private hasPathLikeAnnotationArgument(argsNode: SyntaxNode): boolean {
    for (const child of argsNode.namedChildren) {
      if (child.type !== 'element_value_pair') return true;
      const key = child.childForFieldName('key')?.text;
      if (key === 'value' || key === 'path' || key === 'urlPatterns') return true;
    }
    return false;
  }

  private extractRequestMappingMethod(argsNode: SyntaxNode): string | undefined {
    for (const child of argsNode.namedChildren) {
      if (child.type !== 'element_value_pair') continue;
      const key = child.childForFieldName('key')?.text;
      if (key !== 'method') continue;
      const value = child.childForFieldName('value');
      if (!value) continue;
      const text = value.text;
      const match = text.match(/RequestMethod\.([A-Z]+)/) ?? text.match(/\b(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/);
      if (match) return match[1];
    }
    return undefined;
  }

  private evaluateJavaStringExpression(node: SyntaxNode, constants: Map<string, string>): string | undefined {
    switch (node.type) {
      case 'string_literal':
        return this.unquoteJavaString(node.text);
      case 'identifier':
        return constants.get(node.text);
      case 'field_access':
      case 'scoped_identifier': {
        const text = node.text;
        return constants.get(text) ?? constants.get(text.substring(text.lastIndexOf('.') + 1));
      }
      case 'parenthesized_expression':
        return node.namedChildren.length === 1
          ? this.evaluateJavaStringExpression(node.namedChildren[0], constants)
          : undefined;
      case 'binary_expression': {
        if (!node.text.includes('+')) return undefined;
        const parts = node.namedChildren;
        if (parts.length < 2) return undefined;
        let combined = '';
        for (const part of parts) {
          const value = this.evaluateJavaStringExpression(part, constants);
          if (value === undefined) return undefined;
          combined += value;
        }
        return combined;
      }
      default:
        return undefined;
    }
  }

  private unquoteJavaString(value: string): string {
    if (!value.startsWith('"') || !value.endsWith('"')) return value;
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.replace(/^"|"$/g, '');
    }
  }

  /** Extract parameter type names from formal_parameters. */
  private extractMethodParamTypes(paramsNode: SyntaxNode | null | undefined, file: string): string[] {
    if (!paramsNode) return [];
    const types: string[] = [];
    for (const child of paramsNode.children) {
      if (child.type === 'formal_parameter' || child.type === 'spread_parameter') {
        const typeNode = child.childForFieldName('type');
        const typeName = this.extractJavaTypeName(typeNode);
        if (typeName) {
          types.push(typeName);
          // Track reference type params for dependency resolution
          if (this.isReferenceType(typeName)) {
            this.parseTypeRefs.push({
              file,
              referencedType: typeName,
              context: 'parameter',
              line: child.startPosition.row + 1,
            });
          }
        }
      }
    }
    return types;
  }

  /** Map Java method parameter names to their declared type for receiver call resolution. */
  private extractMethodParamTypeMap(paramsNode: SyntaxNode | null | undefined): Map<string, string> {
    const types = new Map<string, string>();
    if (!paramsNode) return types;
    for (const child of paramsNode.children) {
      if (child.type !== 'formal_parameter' && child.type !== 'spread_parameter') continue;
      const typeName = this.extractJavaTypeName(child.childForFieldName('type'));
      const nameNode = child.childForFieldName('name')
        ?? [...child.namedChildren].reverse().find(node => node.type === 'identifier');
      if (typeName && nameNode) types.set(nameNode.text, typeName);
    }
    return types;
  }

  private addJavaMethodFunctionalSignature(
    signaturesByMethod: Map<string, JavaMethodFunctionalSignature[]>,
    methodName: string,
    paramsNode: SyntaxNode | null | undefined,
  ): void {
    const signature = this.extractJavaMethodFunctionalSignature(paramsNode);
    if (!signature) return;
    const signatures = signaturesByMethod.get(methodName) ?? [];
    signatures.push(signature);
    signaturesByMethod.set(methodName, signatures);
  }

  private extractJavaMethodFunctionalSignature(
    paramsNode: SyntaxNode | null | undefined,
  ): JavaMethodFunctionalSignature | undefined {
    if (!paramsNode) return undefined;
    const parameterTypes: Array<string[] | undefined> = [];
    let hasFunctionalParam = false;
    for (const child of paramsNode.children) {
      if (child.type !== 'formal_parameter' && child.type !== 'spread_parameter') continue;
      const typeText = this.extractJavaTypeText(child.childForFieldName('type'));
      const functionalTypes = this.extractJavaFunctionalParamTypes(typeText);
      parameterTypes.push(functionalTypes.length > 0 ? functionalTypes : undefined);
      if (functionalTypes.length > 0) hasFunctionalParam = true;
    }
    if (!hasFunctionalParam) return undefined;
    return {
      parameterCount: parameterTypes.length,
      parameterTypes,
    };
  }

  private extractJavaFunctionalParamTypes(typeText: string | undefined): string[] {
    if (!typeText) return [];
    const normalized = normalizeJavaTypeText(typeText);
    const genericStart = normalized.indexOf('<');
    if (genericStart < 0) return [];
    const rawType = simpleTypeName(normalized.slice(0, genericStart));
    const genericArgs = splitTopLevelJavaGenericArgs(normalized.slice(genericStart + 1, normalized.lastIndexOf('>')))
      .map(javaGenericArgumentSimpleType)
      .filter((arg): arg is string => Boolean(arg));
    if (genericArgs.length === 0) return [];

    const oneParamInterfaces = new Set([
      'Consumer',
      'Predicate',
      'Function',
      'UnaryOperator',
      'CheckedConsumer',
      'CheckedFunction',
      'CheckedPredicate',
      'ThrowingConsumer',
      'ThrowingFunction',
      'ThrowingPredicate',
    ]);
    if (oneParamInterfaces.has(rawType)) return genericArgs.slice(0, 1);

    const twoParamInterfaces = new Set([
      'BiConsumer',
      'BiFunction',
      'BinaryOperator',
      'BiPredicate',
      'CheckedBiConsumer',
      'CheckedBiFunction',
      'CheckedBiPredicate',
      'ThrowingBiConsumer',
      'ThrowingBiFunction',
      'ThrowingBiPredicate',
    ]);
    if (twoParamInterfaces.has(rawType)) return genericArgs.slice(0, 2);

    return [];
  }

  /** Add local Java variable declarations to the receiver type scope. */
  /** Cursor-driven: only the six declaration node types are materialized. */
  private collectJavaLocalVariableTypes(
    node: SyntaxNode,
    receiverTypes: Map<string, string>,
    file: string,
    shadowedNames?: Set<string>,
    enclosingClass?: string,
  ): void {
    const cursor = node.walk();
    const rootDepth = cursor.currentDepth;
    if (LOCAL_VARIABLE_TYPES.has(cursor.nodeType)) {
      this.handleLocalVariableNode(node, cursor.nodeType, receiverTypes, file, shadowedNames, enclosingClass);
    }
    while (true) {
      if (!cursor.gotoFirstChild()) {
        while (!cursor.gotoNextSibling()) {
          if (!cursor.gotoParent()) return;
          if (cursor.currentDepth <= rootDepth) return;
        }
      }
      const nodeType = cursor.nodeType;
      if (LOCAL_VARIABLE_TYPES.has(nodeType)) {
        this.handleLocalVariableNode(cursor.currentNode, nodeType, receiverTypes, file, shadowedNames, enclosingClass);
      }
    }
  }

  private handleLocalVariableNode(
    node: SyntaxNode,
    nodeType: string,
    receiverTypes: Map<string, string>,
    file: string,
    shadowedNames?: Set<string>,
    enclosingClass?: string,
  ): void {
    const bindReceiverType = (typeName: string | null | undefined, nameNode: SyntaxNode | null | undefined): void => {
      if (!typeName || !nameNode) return;
      receiverTypes.set(nameNode.text, typeName);
      shadowedNames?.add(nameNode.text);
      if (this.isReferenceType(typeName)) {
        this.parseTypeRefs.push({
          file,
          referencedType: typeName,
          context: 'parameter',
          line: node.startPosition.row + 1,
        });
      }
    };

    if (nodeType === 'enhanced_for_statement') {
      const typeName = this.extractJavaTypeName(node.childForFieldName('type'));
      const nameNode = node.childForFieldName('name')
        ?? [...node.namedChildren].find(child => child.type === 'identifier');
      bindReceiverType(typeName, nameNode);
    }

    if (nodeType === 'catch_formal_parameter') {
      const namedChildren = node.namedChildren;
      const catchTypeNode = namedChildren.find(child => child.type === 'catch_type');
      const typeName = catchTypeNode
        ? this.extractJavaTypeName(catchTypeNode.namedChildren[0] ?? catchTypeNode)
        : undefined;
      const nameNode = node.childForFieldName('name')
        ?? [...namedChildren].reverse().find(child => child.type === 'identifier');
      bindReceiverType(typeName, nameNode);
    }

    if (nodeType === 'type_pattern') {
      const namedChildren = node.namedChildren;
      const typeName = this.extractJavaTypeName(node.childForFieldName('type') ?? namedChildren[0]);
      const nameNode = node.childForFieldName('name')
        ?? [...namedChildren].reverse().find(child => child.type === 'identifier');
      bindReceiverType(typeName, nameNode);
    }

    if (nodeType === 'instanceof_expression') {
      const namedChildren = node.namedChildren;
      const typeIndex = namedChildren.findIndex(child =>
        child.type === 'type_identifier'
        || child.type === 'generic_type'
        || child.type === 'scoped_type_identifier'
      );
      const typeNode = typeIndex >= 0 ? namedChildren[typeIndex] : undefined;
      const nameNode = typeIndex >= 0
        ? namedChildren.slice(typeIndex + 1).find(child => child.type === 'identifier')
        : undefined;
      bindReceiverType(this.extractJavaTypeName(typeNode), nameNode);
    }

    if (nodeType === 'resource') {
      const typeName = this.extractJavaTypeName(node.childForFieldName('type'));
      const rawTypeName = this.extractJavaTypeText(node.childForFieldName('type'));
      const nameNode = node.childForFieldName('name');
      if (typeName && nameNode) {
        const inferredType = typeName === 'var'
          ? this.resolveJavaExpressionTypeText(node.childForFieldName('value'), receiverTypes, enclosingClass)
          : typeName;
        if (inferredType) {
          receiverTypes.set(nameNode.text, inferredType);
          shadowedNames?.add(nameNode.text);
        }
        if (typeName !== 'var' && this.isReferenceType(typeName)) {
          this.parseTypeRefs.push({
            file,
            referencedType: rawTypeName ?? typeName,
            context: 'parameter',
            line: node.startPosition.row + 1,
          });
        }
      }
    }

    if (nodeType === 'local_variable_declaration') {
      const typeName = this.extractJavaTypeName(node.childForFieldName('type'));
      const rawTypeName = this.extractJavaTypeText(node.childForFieldName('type'));
      if (typeName) {
        for (const declarator of node.children.filter(child => child.type === 'variable_declarator')) {
            const nameNode = declarator.childForFieldName('name') ?? declarator.children.find(child => child.type === 'identifier');
            if (nameNode) {
              const inferredType = typeName === 'var'
                ? this.resolveJavaExpressionTypeText(declarator.childForFieldName('value'), receiverTypes, enclosingClass)
                : typeName;
              if (!inferredType) continue;
              receiverTypes.set(nameNode.text, inferredType);
              shadowedNames?.add(nameNode.text);
          }
        }
        if (typeName !== 'var' && this.isReferenceType(typeName)) {
          this.parseTypeRefs.push({
            file,
            referencedType: rawTypeName ?? typeName,
            context: 'parameter',
            line: node.startPosition.row + 1,
          });
        }
      }
    }
  }

  /** True if a type name represents a reference type (not a primitive or void). */
  private isReferenceType(name: string): boolean {
    const primitives = new Set(['void', 'int', 'long', 'double', 'float', 'boolean', 'char', 'byte', 'short', 'String', 'Object']);
    return !primitives.has(name) && /^[A-Z]/.test(name);
  }

  private getJavaVisibility(node: SyntaxNode): Visibility {
    for (const child of node.children) {
      if (child.type === 'modifiers') {
        const text = child.text;
        if (text.includes('public')) return 'public';
        if (text.includes('private')) return 'private';
        if (text.includes('protected')) return 'protected';
      }
    }
    return 'internal'; // package-private
  }

  private getJavaModule(filePath: string): string {
    // Extract module from Maven/Gradle path convention: <module>/src/main/java/...
    const parts = filePath.split('/');
    const srcIdx = parts.indexOf('src');
    if (srcIdx > 0) return parts.slice(0, srcIdx).join('/');
    return parts.length > 1 ? parts[0] : '';
  }

  // ─── TypeScript/JavaScript ────────────────────────────────

  private extractTypeScript(
    node: SyntaxNode,
    file: string,
    lines: string[],
    symbols: SymbolInfo[],
    imports: ImportInfo[],
    calls: CallInfo[],
    references: ReferenceInfo[],
    parentClass?: string,
  ): void {
    for (const child of node.children) {
      switch (child.type) {
        case 'import_statement': {
          const source = child.children.find(c => c.type === 'string')?.text?.replace(/['"]/g, '');
          if (source) {
            const importedSymbols: string[] = [];
            const clause = child.children.find(c => c.type === 'import_clause');
            if (clause) {
              this.collectImportedNames(clause, importedSymbols);
            }
            imports.push({
              source,
              symbols: importedSymbols,
              file,
              line: child.startPosition.row + 1,
              isExternal: !source.startsWith('.') && !source.startsWith('/'),
            });
            for (const symbolName of importedSymbols) {
              this.scriptCallbackContext?.importedSymbols.add(symbolName);
            }
          }
          break;
        }
        case 'class_declaration': {
          const nameNode = child.childForFieldName('name');
          if (nameNode) {
            symbols.push({
              name: nameNode.text,
              kind: 'class',
              file,
              line: child.startPosition.row + 1,
              column: child.startPosition.column + 1,
              endLine: child.endPosition.row + 1,
              signature: this.getLineText(lines, child.startPosition.row).trim(),
              visibility: this.getTsVisibility(child),
              module: this.getTsModule(file),
              parent: parentClass,
            });
            const body = child.childForFieldName('body');
            if (body) {
              this.extractTypeScript(body, file, lines, symbols, imports, calls, references, nameNode.text);
            }
          }
          break;
        }
        case 'interface_declaration':
        case 'type_alias_declaration': {
          const nameNode = child.childForFieldName('name');
          if (nameNode) {
            symbols.push({
              name: nameNode.text,
              kind: child.type === 'interface_declaration' ? 'interface' : 'type',
              file,
              line: child.startPosition.row + 1,
              column: child.startPosition.column + 1,
              endLine: child.endPosition.row + 1,
              signature: this.getLineText(lines, child.startPosition.row).trim(),
              visibility: this.getTsVisibility(child),
              module: this.getTsModule(file),
              parent: parentClass,
            });
          }
          break;
        }
        case 'function_declaration':
        case 'method_definition': {
          const nameNode = child.childForFieldName('name');
          if (nameNode) {
            const funcName = parentClass ? `${parentClass}.${nameNode.text}` : nameNode.text;
            this.registerScriptCallableSymbol(nameNode.text, parentClass);
            symbols.push({
              name: nameNode.text,
              kind: child.type === 'method_definition' ? 'method' : 'function',
              file,
              line: child.startPosition.row + 1,
              column: child.startPosition.column + 1,
              endLine: child.endPosition.row + 1,
              signature: this.getSignatureLine(lines, child.startPosition.row),
              visibility: this.getTsVisibility(child),
              module: this.getTsModule(file),
              parent: parentClass,
            });
            const body = child.childForFieldName('body');
            if (body) {
              this.extractCallsFromNode(body, file, lines, calls, references, funcName, undefined, undefined, parentClass, this.scriptCallbackContext);
            }
            // TS constructor parameter properties:
            // `constructor(private readonly db: CodeGraphDb)` declares a class
            // field `db` of type CodeGraphDb. These are the dominant field-decl
            // form in this codebase and are not public_field_definition nodes,
            // so extract them explicitly to feed receiver-field resolution.
            if (parentClass && nameNode.text === 'constructor') {
              this.extractTsConstructorParameterProperties(child, file, lines, symbols, parentClass);
            }
          }
          break;
        }
        case 'public_field_definition':
        case 'property_signature': {
          // TS class fields. Capturing the declared type into returnType lets
          // the call resolver turn `this.<field>.method()` into
          // `<FieldType>.method` (receiver-field resolution), which was
          // previously impossible because TS field types were never recorded.
          const nameNode = child.childForFieldName('name');
          if (nameNode && (nameNode.type === 'property_identifier' || nameNode.type === 'identifier')) {
            symbols.push({
              name: nameNode.text,
              kind: 'field',
              file,
              line: child.startPosition.row + 1,
              column: child.startPosition.column + 1,
              endLine: child.endPosition.row + 1,
              signature: this.getLineText(lines, child.startPosition.row).trim(),
              visibility: this.getTsVisibility(child),
              module: this.getTsModule(file),
              parent: parentClass,
              returnType: this.extractTsTypeName(child.childForFieldName('type')),
            });
          }
          break;
        }
        case 'lexical_declaration':
        case 'variable_declaration': {
          // Handle `const fn = () => {}` and `export const x = ...`
          for (const declarator of child.children) {
            if (declarator.type === 'variable_declarator') {
              const nameNode = declarator.childForFieldName('name');
              const value = declarator.childForFieldName('value');
              if (nameNode) {
                const isArrowFunction = value?.type === 'arrow_function';
                const isFunctionExpression = value?.type === 'function_expression';
                if (isArrowFunction || isFunctionExpression) {
                  this.registerScriptCallableSymbol(nameNode.text, parentClass);
                }
                symbols.push({
                  name: nameNode.text,
                  kind: isArrowFunction ? 'function' : 'variable',
                  file,
                  line: child.startPosition.row + 1,
                  column: child.startPosition.column + 1,
                  endLine: child.endPosition.row + 1,
                  signature: this.getLineText(lines, child.startPosition.row).trim(),
                  visibility: this.getTsVisibility(child),
                  module: this.getTsModule(file),
                  parent: parentClass,
                });
                if (isArrowFunction && value) {
                  const funcName = parentClass ? `${parentClass}.${nameNode.text}` : nameNode.text;
                  this.extractCallsFromNode(value, file, lines, calls, references, funcName, undefined, undefined, parentClass, this.scriptCallbackContext);
                }
                if (value?.type === 'object') {
                  this.extractTypeScriptObjectPropertySymbols(value, file, lines, symbols, nameNode.text);
                }
              }
            }
          }
          break;
        }
        case 'export_statement': {
          // Recurse into the exported declaration
          this.extractTypeScript(child, file, lines, symbols, imports, calls, references, parentClass);
          break;
        }
        default:
          this.extractTypeScript(child, file, lines, symbols, imports, calls, references, parentClass);
          break;
      }
    }
  }

  private extractTypeScriptObjectPropertySymbols(
    objectNode: SyntaxNode,
    file: string,
    lines: string[],
    symbols: SymbolInfo[],
    parentName: string,
  ): void {
    for (const pair of objectNode.namedChildren.filter(child => child.type === 'pair')) {
      const keyNode = pair.childForFieldName('key') ?? pair.namedChildren[0];
      const name = this.tsObjectPropertyName(keyNode);
      if (!name) continue;
      symbols.push({
        name,
        kind: 'field',
        file,
        line: pair.startPosition.row + 1,
        column: pair.startPosition.column + 1,
        endLine: pair.endPosition.row + 1,
        signature: this.getLineText(lines, pair.startPosition.row).trim(),
        visibility: 'public',
        module: this.getTsModule(file),
        parent: parentName,
      });
    }
  }

  /**
   * Resolve the base type name from a TS `type_annotation` (the `type` field of
   * a class field / property). `: CodeGraphDb` -> `CodeGraphDb`,
   * `: Map<string, X>` -> `Map`, `ns.Foo` -> `Foo`. Returns undefined when there
   * is no usable nominal type (unions, literals, primitives are not useful
   * receiver types).
   */
  /**
   * Extract TypeScript constructor parameter properties (`constructor(private
   * readonly db: CodeGraphDb)`) as class field symbols carrying their declared
   * type, so `this.db.method()` can be resolved to `CodeGraphDb.method`.
   */
  private extractTsConstructorParameterProperties(
    constructorNode: SyntaxNode,
    file: string,
    lines: string[],
    symbols: SymbolInfo[],
    parentClass: string,
  ): void {
    const params = constructorNode.childForFieldName('parameters');
    if (!params) return;
    for (const param of params.namedChildren) {
      if (param.type !== 'required_parameter' && param.type !== 'optional_parameter') continue;
      // Only parameters with an accessibility/readonly modifier become fields.
      const hasModifier = param.children.some(c =>
        c.type === 'accessibility_modifier' || c.text === 'readonly' || c.type === 'override_modifier');
      if (!hasModifier) continue;
      const pattern = param.childForFieldName('pattern');
      if (!pattern || (pattern.type !== 'identifier' && pattern.type !== 'property_identifier')) continue;
      symbols.push({
        name: pattern.text,
        kind: 'field',
        file,
        line: param.startPosition.row + 1,
        column: param.startPosition.column + 1,
        endLine: param.endPosition.row + 1,
        signature: this.getLineText(lines, param.startPosition.row).trim(),
        visibility: 'private',
        module: this.getTsModule(file),
        parent: parentClass,
        returnType: this.extractTsTypeName(param.childForFieldName('type')),
      });
    }
  }

  private extractTsTypeName(typeAnnotation: SyntaxNode | null | undefined): string | undefined {
    if (!typeAnnotation) return undefined;
    const raw = (typeAnnotation.text ?? '').replace(/^:\s*/, '').trim();
    if (!raw) return undefined;
    const match = raw.match(/^[A-Za-z_$][A-Za-z0-9_$.]*/);
    if (!match) return undefined;
    const base = (match[0].split('.').pop() ?? match[0]).trim();
    if (!base) return undefined;
    // Built-in/primitive types are never project classes with resolvable methods.
    const PRIMITIVES = new Set(['string', 'number', 'boolean', 'any', 'unknown', 'void', 'never', 'object', 'symbol', 'bigint', 'undefined', 'null']);
    if (PRIMITIVES.has(base)) return undefined;
    return base;
  }

  private tsObjectPropertyName(node: SyntaxNode | null | undefined): string | undefined {
    if (!node) return undefined;
    if (node.type === 'property_identifier' || node.type === 'identifier') return node.text;
    if (node.type === 'string') {
      const fragment = node.namedChildren.find(child => child.type === 'string_fragment');
      return fragment?.text;
    }
    return undefined;
  }

  private collectImportedNames(node: SyntaxNode, names: string[]): void {
    if (node.type === 'identifier') {
      names.push(node.text);
    }
    if (node.type === 'import_specifier') {
      const nameNode = node.childForFieldName('name') ?? node.children.find(c => c.type === 'identifier');
      if (nameNode) names.push(nameNode.text);
      return;
    }
    for (const child of node.children) {
      this.collectImportedNames(child, names);
    }
  }

  private getTsVisibility(node: SyntaxNode): Visibility {
    const text = node.text;
    if (text.startsWith('export')) return 'public';
    if (text.includes('private')) return 'private';
    if (text.includes('protected')) return 'protected';
    return 'internal';
  }

  private getTsModule(filePath: string): string {
    const parts = filePath.split('/');
    // If in src/xxx/..., use first sub-directory as module
    const srcIdx = parts.indexOf('src');
    if (srcIdx >= 0 && srcIdx + 1 < parts.length - 1) {
      return parts[srcIdx + 1];
    }
    return '';
  }

  // ─── Python ─────────────────────────────────────────────

  private extractPython(
    node: SyntaxNode,
    file: string,
    lines: string[],
    symbols: SymbolInfo[],
    imports: ImportInfo[],
    calls: CallInfo[],
    references: ReferenceInfo[],
    parentClass?: string,
  ): void {
    for (const child of node.children) {
      switch (child.type) {
        case 'import_statement': {
          const nameNode = child.children.find(c => c.type === 'dotted_name');
          if (nameNode) {
            imports.push({
              source: nameNode.text,
              symbols: [],
              file,
              line: child.startPosition.row + 1,
              isExternal: !nameNode.text.startsWith('.'),
            });
            this.scriptCallbackContext?.importedSymbols.add(nameNode.text);
          }
          break;
        }
        case 'import_from_statement': {
          const moduleNode = child.childForFieldName('module_name') ?? child.children.find(c => c.type === 'dotted_name' || c.type === 'relative_import');
          const importedNames: string[] = [];
          for (const c of child.children) {
            if (c.type === 'dotted_name' && c !== moduleNode) {
              importedNames.push(c.text);
            }
            if (c.type === 'aliased_import') {
              const nameNode = c.childForFieldName('name') ?? c.children.find(n => n.type === 'dotted_name');
              if (nameNode) importedNames.push(nameNode.text);
            }
          }
          if (moduleNode) {
            imports.push({
              source: moduleNode.text,
              symbols: importedNames,
              file,
              line: child.startPosition.row + 1,
              isExternal: !moduleNode.text.startsWith('.'),
            });
            for (const symbolName of importedNames) {
              this.scriptCallbackContext?.importedSymbols.add(symbolName);
            }
          }
          break;
        }
        case 'class_definition': {
          const nameNode = child.childForFieldName('name');
          if (nameNode) {
            symbols.push({
              name: nameNode.text,
              kind: 'class',
              file,
              line: child.startPosition.row + 1,
              column: child.startPosition.column + 1,
              endLine: child.endPosition.row + 1,
              signature: this.getLineText(lines, child.startPosition.row).trim(),
              visibility: nameNode.text.startsWith('_') ? 'private' : 'public',
              module: this.getPythonModule(file),
              parent: parentClass,
            });
            const body = child.childForFieldName('body');
            if (body) {
              this.extractPython(body, file, lines, symbols, imports, calls, references, nameNode.text);
            }
          }
          break;
        }
        case 'function_definition': {
          const nameNode = child.childForFieldName('name');
          if (nameNode) {
            const kind: SymbolKind = parentClass ? 'method' : 'function';
            const funcName = parentClass ? `${parentClass}.${nameNode.text}` : nameNode.text;
            this.registerScriptCallableSymbol(nameNode.text, parentClass);
            symbols.push({
              name: nameNode.text,
              kind,
              file,
              line: child.startPosition.row + 1,
              column: child.startPosition.column + 1,
              endLine: child.endPosition.row + 1,
              signature: this.getSignatureLine(lines, child.startPosition.row),
              visibility: nameNode.text.startsWith('__') ? 'private'
                : nameNode.text.startsWith('_') ? 'protected' : 'public',
              module: this.getPythonModule(file),
              parent: parentClass,
            });
            const body = child.childForFieldName('body');
            if (body) {
              this.extractCallsFromNode(body, file, lines, calls, references, funcName, undefined, undefined, parentClass, this.scriptCallbackContext);
            }
          }
          break;
        }
        default:
          this.extractPython(child, file, lines, symbols, imports, calls, references, parentClass);
          break;
      }
    }
  }

  private getPythonModule(filePath: string): string {
    // Convert file path to Python module path
    return filePath.replace(/\//g, '.').replace(/\.py$/, '').replace(/\.__init__$/, '');
  }

  // ─── Shared helpers ─────────────────────────────────────

  private maybeExtractJavaFieldUsageFromNode(
    node: SyntaxNode,
    file: string,
    lines: string[],
    context: JavaFieldUsageContext | undefined,
  ): boolean {
    if (!context) return false;
    const classFields = this.javaFieldsByClass.get(context.enclosingClass);
    if (!classFields || classFields.size === 0) return false;

    const addUsage = (
      usageNode: SyntaxNode,
      fieldName: string,
      field: JavaFieldInfo | undefined,
      accessKind: FieldAccessKind,
      receiverText: string | undefined,
      confidence: number,
      resolutionKind: string,
    ): void => {
      const key = `${file}\0${usageNode.startIndex}\0${usageNode.endIndex}\0${fieldName}\0${receiverText ?? ''}`;
      if (context.seen.has(key)) return;
      context.seen.add(key);
      const row = usageNode.startPosition.row;
      this.parseFieldUsages.push({
        fieldName,
        fieldFqName: field?.fieldFqName,
        ownerClass: field?.ownerClass,
        file,
        line: row + 1,
        column: usageNode.startPosition.column + 1,
        enclosingClass: context.enclosingClass,
        enclosingSymbol: context.enclosingSymbol,
        accessKind,
        receiverText,
        context: this.getContextLines(lines, row, 0),
        confidence,
        resolutionKind,
      });
    };

    if (node.type === 'field_access') {
      const fieldNode = node.childForFieldName('field')
        ?? [...node.namedChildren].reverse().find(child => child.type === 'identifier' || child.type === 'field_identifier');
      if (fieldNode) {
        const receiverText = node.childForFieldName('object')?.text;
        const resolved = this.resolveJavaFieldAccess(fieldNode.text, receiverText, context.enclosingClass, context.receiverTypes);
        addUsage(
          node,
          fieldNode.text,
          resolved.field,
          javaFieldAccessKind(node, context.isConstructor, resolved.field?.ownerClass === context.enclosingClass),
          receiverText,
          resolved.confidence,
          resolved.resolutionKind,
        );
      }
      return false;
    }

    if (node.type === 'identifier' && isJavaIdentifierReferenceCandidate(node)) {
      const field = classFields.get(node.text);
      if (field && !context.shadowedNames.has(node.text)) {
        addUsage(
          node,
          node.text,
          field,
          javaFieldAccessKind(node, context.isConstructor, true),
          undefined,
          0.85,
          'class-field',
        );
      }
    }
    return false;
  }

  /**
   * Cursor-driven walk over `node`'s subtree. Only nodes whose type is in
   * CALL_EXTRACTION_TYPES are materialized and dispatched; the rest of the
   * traversal moves the native cursor without unmarshalling anything.
   */
  private extractCallsFromNode(
    node: SyntaxNode,
    file: string,
    lines: string[],
    calls: CallInfo[],
    references: ReferenceInfo[],
    callerName: string,
    receiverTypes?: Map<string, string>,
    fieldUsageContext?: JavaFieldUsageContext,
    enclosingClass?: string,
    callbackContext?: ScriptCallbackContext,
  ): void {
    // Identifiers are the most common named node; materializing each one
    // costs an unmarshal. cursor.nodeText is a cheap string, so pre-screen:
    // an identifier only matters when it names a known class field (field
    // usage) or a known callable (callback reference).
    const classFields = fieldUsageContext
      ? this.javaFieldsByClass.get(fieldUsageContext.enclosingClass)
      : undefined;
    const classMethods = callbackContext && enclosingClass
      ? callbackContext.classMethods.get(enclosingClass)
      : undefined;
    const identifierIsInteresting = (text: string): boolean => {
      if (classFields?.has(text)) return true;
      if (!callbackContext) return false;
      return (classMethods?.has(text) ?? false)
        || callbackContext.callableSymbols.has(text)
        || callbackContext.importedSymbols.has(text);
    };

    const cursor = node.walk();
    const rootDepth = cursor.currentDepth;
    let descend = true;
    const rootType = cursor.nodeType;
    if (CALL_EXTRACTION_TYPES.has(rootType)) {
      descend = !this.handleCallExtractionNode(node, rootType, file, lines, calls, references, callerName, receiverTypes, fieldUsageContext, enclosingClass, callbackContext);
    }
    while (true) {
      if (!(descend && cursor.gotoFirstChild())) {
        while (!cursor.gotoNextSibling()) {
          if (!cursor.gotoParent()) return;
          if (cursor.currentDepth <= rootDepth) return;
        }
      }
      const nodeType = cursor.nodeType;
      if (CALL_EXTRACTION_TYPES.has(nodeType)
        && (nodeType !== 'identifier' || identifierIsInteresting(cursor.nodeText))) {
        descend = !this.handleCallExtractionNode(cursor.currentNode, nodeType, file, lines, calls, references, callerName, receiverTypes, fieldUsageContext, enclosingClass, callbackContext);
      } else {
        descend = true;
      }
    }
  }

  /** @returns true when the node's subtree is fully handled (do not descend). */
  private handleCallExtractionNode(
    node: SyntaxNode,
    nodeType: string,
    file: string,
    lines: string[],
    calls: CallInfo[],
    references: ReferenceInfo[],
    callerName: string,
    receiverTypes?: Map<string, string>,
    fieldUsageContext?: JavaFieldUsageContext,
    enclosingClass?: string,
    callbackContext?: ScriptCallbackContext,
  ): boolean {
    if ((nodeType === 'field_access' || nodeType === 'identifier')
      && this.maybeExtractJavaFieldUsageFromNode(node, file, lines, fieldUsageContext)) {
      return true;
    }

    if (nodeType === 'member_expression' || nodeType === 'attribute' || nodeType === 'identifier') {
      const callbackReference = this.resolveCallbackReferenceCallee(node, enclosingClass, callbackContext);
      if (callbackReference && isCallbackValuePosition(node)) {
        calls.push({
          caller: callerName,
          callee: callbackReference,
          file,
          line: node.startPosition.row + 1,
          confidence: 0.7,
          resolutionKind: 'callback-reference',
        });
        references.push({
          file,
          line: node.startPosition.row + 1,
          column: node.startPosition.column + 1,
          kind: 'call',
          context: this.getContextLines(lines, node.startPosition.row, 0),
          symbolName: callbackReference,
        });
        return true;
      }
    }

    if (nodeType === 'method_declaration' || nodeType === 'constructor_declaration') {
      const nameNode = node.childForFieldName('name') ?? node.children.find(child => child.type === 'identifier');
      const body = node.childForFieldName('body');
      if (nameNode && body) {
        const paramsNode = node.childForFieldName('parameters');
        const nestedReceiverTypes = new Map(receiverTypes ?? []);
        for (const [name, type] of this.extractMethodParamTypeMap(paramsNode)) nestedReceiverTypes.set(name, type);
        const nestedShadowedNames = this.extractJavaParameterNames(paramsNode);
        this.collectJavaLocalVariableTypes(body, nestedReceiverTypes, file, nestedShadowedNames, enclosingClass);
        const nestedCallerName = `${callerName}.${nameNode.text}`;
        const nestedFieldUsageContext = fieldUsageContext
          ? {
            ...fieldUsageContext,
            receiverTypes: nestedReceiverTypes,
            shadowedNames: new Set([...fieldUsageContext.shadowedNames, ...nestedShadowedNames]),
          }
          : fieldUsageContext;
        this.extractCallsFromNode(body, file, lines, calls, references, nestedCallerName, nestedReceiverTypes, nestedFieldUsageContext, enclosingClass, callbackContext);
        return true;
      }
    }

    if (nodeType === 'lambda_expression') {
      const callbackName = `${callerName}.lambda${node.startPosition.row + 1}_${node.startPosition.column + 1}`;
      const lambdaReceiverTypes = this.extendJavaLambdaReceiverTypes(node, receiverTypes, enclosingClass);
      const lambdaFieldUsageContext = fieldUsageContext
        ? {
          ...fieldUsageContext,
          receiverTypes: lambdaReceiverTypes ?? fieldUsageContext.receiverTypes,
          shadowedNames: this.extendJavaLambdaShadowedNames(node, fieldUsageContext.shadowedNames),
        }
        : fieldUsageContext;
      calls.push({
        caller: callerName,
        callee: callbackName,
        file,
        line: node.startPosition.row + 1,
        confidence: 0.6,
        resolutionKind: 'lambda-callback',
      });
      references.push({
        file,
        line: node.startPosition.row + 1,
        column: node.startPosition.column + 1,
        kind: 'call',
        context: this.getContextLines(lines, node.startPosition.row, 0),
        symbolName: callbackName,
      });
      for (const child of node.children) {
        this.extractCallsFromNode(child, file, lines, calls, references, callbackName, lambdaReceiverTypes, lambdaFieldUsageContext, enclosingClass, callbackContext);
      }
      return true;
    }

    if ((nodeType === 'arrow_function' || nodeType === 'function_expression' || nodeType === 'lambda') && isCallbackValuePosition(node)) {
      const callbackName = `${callerName}.lambda${node.startPosition.row + 1}_${node.startPosition.column + 1}`;
      calls.push({
        caller: callerName,
        callee: callbackName,
        file,
        line: node.startPosition.row + 1,
        confidence: 0.6,
        resolutionKind: 'lambda-callback',
      });
      references.push({
        file,
        line: node.startPosition.row + 1,
        column: node.startPosition.column + 1,
        kind: 'call',
        context: this.getContextLines(lines, node.startPosition.row, 0),
        symbolName: callbackName,
      });
      for (const child of node.children) {
        this.extractCallsFromNode(child, file, lines, calls, references, callbackName, receiverTypes, fieldUsageContext, enclosingClass, callbackContext);
      }
      return true;
    }

    // Java: method invocation — obj.method(args)
    if (nodeType === 'object_creation_expression') {
      const typeNode = node.childForFieldName('type')
        ?? node.namedChildren.find(child =>
          child.type === 'type_identifier'
          || child.type === 'generic_type'
          || child.type === 'scoped_type_identifier'
        );
      const typeName = this.extractJavaTypeName(typeNode) ?? typeNode?.text;
      if (typeName) {
        const calleeName = `${typeName}.new`;
        calls.push({ caller: callerName, callee: calleeName, file, line: node.startPosition.row + 1 });
        references.push({
          file,
          line: node.startPosition.row + 1,
          column: node.startPosition.column + 1,
          kind: 'call',
          context: this.getContextLines(lines, node.startPosition.row, 0),
          symbolName: calleeName,
        });
      }
    }

    if (nodeType === 'method_invocation') {
      const funcNode = node.childForFieldName('name') ?? node.children[0];
      if (funcNode) {
        let calleeName = '';
        let resolutionKind: string | undefined;
        const objectNode = node.childForFieldName('object');
        if (objectNode) {
          const receiverType = objectNode.type === 'method_invocation'
            ? this.resolveJavaExpressionTypeText(objectNode, receiverTypes, enclosingClass)
            : resolveJavaInvocationReceiver(objectNode.text, receiverTypes);
          calleeName = `${receiverType ?? objectNode.text}.${funcNode.text}`;
          if (receiverType) resolutionKind = 'receiver-type';
        } else {
          calleeName = this.resolveJavaStaticImportCallee(funcNode.text) ?? funcNode.text;
          if (calleeName !== funcNode.text) resolutionKind = 'static-import';
        }
        if (calleeName) {
          calls.push({
            caller: callerName,
            callee: calleeName,
            file,
            line: node.startPosition.row + 1,
            resolutionKind,
          });
          references.push({
            file,
            line: node.startPosition.row + 1,
            column: node.startPosition.column + 1,
            kind: 'call',
            context: this.getContextLines(lines, node.startPosition.row, 0),
            symbolName: calleeName,
          });
        }
      }
    }

    // Java: method reference — ClassName::methodName or instance::method
    if (nodeType === 'method_reference') {
      const children = node.children.filter(c => c.type !== '::');
      if (children.length >= 2) {
        const typePart = children[0].text;
        const methodPart = children[1].text;
        const receiverType = this.resolveJavaMethodReferenceReceiver(typePart, receiverTypes, enclosingClass);
        const calleeName = methodPart === 'new' ? `${receiverType}.new` : `${receiverType}.${methodPart}`;
        calls.push({
          caller: callerName,
          callee: calleeName,
          file,
          line: node.startPosition.row + 1,
          confidence: receiverType === typePart ? 0.75 : 0.85,
          resolutionKind: 'method-reference',
        });
        references.push({
          file,
          line: node.startPosition.row + 1,
          column: node.startPosition.column + 1,
          kind: 'call',
          context: this.getContextLines(lines, node.startPosition.row, 0),
          symbolName: calleeName,
        });
      }
    }

    // TypeScript/JavaScript: call expression — fn(args) or obj.method(args)
    if (nodeType === 'call_expression') {
      const funcNode = node.childForFieldName('function');
      if (funcNode) {
        const calleeName = this.resolveScriptCallCallee(funcNode, enclosingClass) ?? funcNode.text;
        if (calleeName) {
          calls.push({ caller: callerName, callee: calleeName, file, line: node.startPosition.row + 1 });
          references.push({
            file,
            line: node.startPosition.row + 1,
            column: node.startPosition.column + 1,
            kind: 'call',
            context: this.getContextLines(lines, node.startPosition.row, 0),
            symbolName: calleeName,
          });
        }
      }
    }

    // Python: call
    if (nodeType === 'call') {
      const funcNode = node.childForFieldName('function');
      if (funcNode) {
        const calleeName = this.resolveScriptCallCallee(funcNode, enclosingClass) ?? funcNode.text;
        if (calleeName) {
          calls.push({ caller: callerName, callee: calleeName, file, line: node.startPosition.row + 1 });
          references.push({
            file,
            line: node.startPosition.row + 1,
            column: node.startPosition.column + 1,
            kind: 'call',
            context: this.getContextLines(lines, node.startPosition.row, 0),
            symbolName: calleeName,
          });
        }
      }
    }

    return false;
  }

  private resolveJavaMethodReferenceReceiver(
    receiver: string,
    receiverTypes?: Map<string, string>,
    enclosingClass?: string,
  ): string {
    if (receiver === 'this' && enclosingClass) return enclosingClass;
    if (receiver === 'super' && enclosingClass) return this.javaSuperClassByClass.get(enclosingClass) ?? enclosingClass;
    return resolveReceiverType(receiver, receiverTypes) ?? receiver;
  }

  private resolveScriptCallCallee(
    node: SyntaxNode,
    enclosingClass?: string,
  ): string | undefined {
    if (node.type === 'member_expression') {
      const objectNode = node.childForFieldName('object');
      const propertyNode = node.childForFieldName('property')
        ?? [...node.namedChildren].reverse().find(child => child.type === 'property_identifier' || child.type === 'identifier');
      if (!objectNode || !propertyNode) return undefined;
      if (objectNode.type === 'this' && enclosingClass) return `${enclosingClass}.${propertyNode.text}`;
      const objectText = objectNode.text.trim();
      if (/^[A-Z][A-Za-z0-9_$]*$/.test(objectText)) return `${objectText}.${propertyNode.text}`;
      return undefined;
    }

    if (node.type === 'attribute') {
      const objectNode = node.childForFieldName('object');
      const attributeNode = node.childForFieldName('attribute');
      if (!objectNode || !attributeNode) return undefined;
      if (objectNode.text === 'self' && enclosingClass) return `${enclosingClass}.${attributeNode.text}`;
      return undefined;
    }

    return undefined;
  }

  private resolveCallbackReferenceCallee(
    node: SyntaxNode,
    enclosingClass?: string,
    callbackContext?: ScriptCallbackContext,
  ): string | undefined {
    const memberReference = this.resolveScriptCallCallee(node, enclosingClass);
    if (memberReference) return memberReference;
    if (!callbackContext || node.type !== 'identifier' || !this.isValidCallbackIdentifier(node.text)) return undefined;

    const classMethods = enclosingClass ? callbackContext.classMethods.get(enclosingClass) : undefined;
    if (classMethods?.has(node.text)) {
      return `${enclosingClass}.${node.text}`;
    }

    if (callbackContext.callableSymbols.has(node.text) || callbackContext.importedSymbols.has(node.text)) {
      return node.text;
    }
    return undefined;
  }

  private registerScriptCallableSymbol(name: string, enclosingClass?: string): void {
    if (!this.scriptCallbackContext) return;
    this.scriptCallbackContext.callableSymbols.add(name);
    if (enclosingClass) {
      const methods = this.scriptCallbackContext.classMethods.get(enclosingClass) ?? new Set<string>();
      methods.add(name);
      this.scriptCallbackContext.classMethods.set(enclosingClass, methods);
    }
  }

  private isValidCallbackIdentifier(name: string): boolean {
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
  }

  private extendJavaLambdaReceiverTypes(
    node: SyntaxNode,
    receiverTypes?: Map<string, string>,
    enclosingClass?: string,
  ): Map<string, string> | undefined {
    const paramTypes = this.extractJavaLambdaParamTypeMap(node, receiverTypes, enclosingClass);
    if (paramTypes.size === 0) return receiverTypes;
    const scoped = new Map(receiverTypes ?? []);
    for (const [name, type] of paramTypes) scoped.set(name, type);
    return scoped;
  }

  private extendJavaLambdaShadowedNames(
    node: SyntaxNode,
    shadowedNames: Set<string>,
  ): Set<string> {
    const scoped = new Set(shadowedNames);
    for (const name of this.extractJavaLambdaParamNames(node)) scoped.add(name);
    return scoped;
  }

  private extractJavaLambdaParamTypeMap(
    node: SyntaxNode,
    receiverTypes?: Map<string, string>,
    enclosingClass?: string,
  ): Map<string, string> {
    const types = new Map<string, string>();
    if (node.type !== 'lambda_expression') return types;

    const paramsNode = node.namedChildren[0];
    if (!paramsNode) return types;
    if (paramsNode.type === 'formal_parameters') {
      for (const child of paramsNode.namedChildren) {
        if (child.type !== 'formal_parameter' && child.type !== 'spread_parameter') continue;
        const typeName = this.extractJavaTypeName(child.childForFieldName('type'));
        const nameNode = child.childForFieldName('name')
          ?? [...child.namedChildren].reverse().find(param => param.type === 'identifier');
        if (typeName && nameNode) types.set(nameNode.text, typeName);
      }
      return types;
    }

    const names = this.extractJavaLambdaParamNames(node);
    if (names.length === 0) return types;

    const inferredTypes = this.inferJavaFunctionalArgumentLambdaParamTypes(node, receiverTypes, enclosingClass, names.length)
      ?? (
        names.length === 1
          ? [
            this.inferJavaLambdaCastParamType(node)
              ?? this.inferJavaStreamLambdaParamType(node, receiverTypes, enclosingClass)
              ?? this.inferJavaKnownBuilderLambdaParamType(node, names[0]!)
          ].filter((type): type is string => Boolean(type))
          : undefined
      );
    if (!inferredTypes || inferredTypes.length === 0) return types;
    for (let index = 0; index < Math.min(names.length, inferredTypes.length); index++) {
      const name = names[index];
      const type = inferredTypes[index];
      if (name && type) types.set(name, type);
    }
    return types;
  }

  private extractJavaLambdaParamNames(node: SyntaxNode): string[] {
    if (node.type !== 'lambda_expression') return [];
    const paramsNode = node.namedChildren[0];
    if (!paramsNode) return [];
    if (paramsNode.type === 'identifier') return [paramsNode.text];
    if (paramsNode.type === 'inferred_parameters') {
      return paramsNode.namedChildren
        .filter(child => child.type === 'identifier')
        .map(child => child.text);
    }
    if (paramsNode.type === 'formal_parameters') {
      return paramsNode.namedChildren
        .filter(child => child.type === 'formal_parameter' || child.type === 'spread_parameter')
        .map(child =>
          child.childForFieldName('name')
            ?? [...child.namedChildren].reverse().find(param => param.type === 'identifier')
        )
        .filter((child): child is SyntaxNode => Boolean(child))
        .map(child => child.text);
    }
    return [];
  }

  private inferJavaFunctionalArgumentLambdaParamTypes(
    node: SyntaxNode,
    receiverTypes: Map<string, string> | undefined,
    enclosingClass: string | undefined,
    lambdaParamCount: number,
  ): string[] | undefined {
    if (node.type !== 'lambda_expression') return undefined;
    const context = this.javaLambdaArgumentInvocationContext(node);
    if (!context) return undefined;
    const signatures = this.resolveJavaFunctionalMethodSignatures(context.invocation, receiverTypes, enclosingClass);
    return this.pickJavaLambdaFunctionalParamTypes(signatures, context.argumentIndex, context.argumentCount, lambdaParamCount);
  }

  private javaLambdaArgumentInvocationContext(
    node: SyntaxNode,
  ): { invocation: SyntaxNode; argumentIndex: number; argumentCount: number } | undefined {
    let argumentNode: SyntaxNode = node;
    let argumentList = node.parent;
    while (argumentList?.type === 'parenthesized_expression') {
      argumentNode = argumentList;
      argumentList = argumentList.parent;
    }
    if (!argumentList || argumentList.type !== 'argument_list') return undefined;
    const invocation = argumentList.parent;
    if (!invocation || invocation.type !== 'method_invocation') return undefined;
    const args = argumentList.namedChildren;
    const argumentIndex = args.findIndex(arg => sameSyntaxNode(arg, argumentNode) || syntaxNodeContains(arg, node));
    if (argumentIndex < 0) return undefined;
    return {
      invocation,
      argumentIndex,
      argumentCount: args.length,
    };
  }

  private resolveJavaFunctionalMethodSignatures(
    invocation: SyntaxNode,
    receiverTypes: Map<string, string> | undefined,
    enclosingClass: string | undefined,
  ): JavaMethodFunctionalSignature[] {
    const methodName = invocation.childForFieldName('name')?.text;
    if (!methodName) return [];

    const objectNode = invocation.childForFieldName('object');
    if (objectNode) {
      const receiverType = objectNode.type === 'method_invocation'
        ? this.resolveJavaExpressionTypeText(objectNode, receiverTypes, enclosingClass)
        : resolveJavaInvocationReceiver(objectNode.text, receiverTypes);
      const ownerClass = receiverType
        ? simpleTypeName(receiverType)
        : /^[A-Z]/.test(objectNode.text)
          ? simpleTypeName(objectNode.text)
          : undefined;
      return ownerClass
        ? this.resolveJavaFunctionalMethodSignaturesFromHierarchy(ownerClass, methodName)
        : [];
    }

    const staticCallee = this.resolveJavaStaticImportCallee(methodName);
    if (staticCallee) {
      const owner = staticCallee.slice(0, staticCallee.lastIndexOf('.'));
      const signatures = this.resolveJavaFunctionalMethodSignaturesFromHierarchy(owner, methodName);
      if (signatures.length > 0) return signatures;
    }

    return this.resolveJavaFunctionalMethodSignaturesFromHierarchy(enclosingClass, methodName);
  }

  private resolveJavaFunctionalMethodSignaturesFromHierarchy(
    className: string | undefined,
    methodName: string,
    seenClasses = new Set<string>(),
  ): JavaMethodFunctionalSignature[] {
    const simpleClassName = className ? simpleTypeName(className) : undefined;
    if (!simpleClassName || seenClasses.has(simpleClassName)) return [];
    seenClasses.add(simpleClassName);

    const local = this.javaFunctionalParamTypesByClass.get(simpleClassName)?.get(methodName) ?? [];
    const external = this.resolveExternalJavaClassMembers(simpleClassName, members =>
      members.functionalParamTypesByClass.get(simpleClassName)?.get(methodName)
    ) ?? [];
    const externalSuperClass = this.resolveExternalJavaClassMembers(simpleClassName, members =>
      members.superClassByClass.get(simpleClassName)
    );
    const superClass = this.javaSuperClassByClass.get(simpleClassName) ?? externalSuperClass;
    const inherited = [
      ...this.resolveJavaFunctionalMethodSignaturesFromHierarchy(superClass, methodName, seenClasses),
      ...this.resolveJavaFunctionalMethodSignaturesFromHierarchy(this.javaOuterClassByClass.get(simpleClassName), methodName, seenClasses),
    ];
    return [...local, ...external, ...inherited];
  }

  private pickJavaLambdaFunctionalParamTypes(
    signatures: JavaMethodFunctionalSignature[],
    argumentIndex: number,
    argumentCount: number,
    lambdaParamCount: number,
  ): string[] | undefined {
    const pick = (candidates: JavaMethodFunctionalSignature[]): string[] | undefined => {
      const matched = new Map<string, string[]>();
      for (const signature of candidates) {
        const inferred = signature.parameterTypes[argumentIndex];
        if (!inferred || inferred.length < lambdaParamCount) continue;
        const types = inferred.slice(0, lambdaParamCount);
        matched.set(types.join('\0'), types);
      }
      return matched.size === 1 ? [...matched.values()][0] : undefined;
    };

    return pick(signatures.filter(signature => signature.parameterCount === argumentCount))
      ?? pick(signatures);
  }

  private inferJavaKnownBuilderLambdaParamType(node: SyntaxNode, paramName: string): string | undefined {
    if (!this.isJavaTypeVisible('XContentBuilder')) return undefined;
    return this.javaLambdaBodyUsesReceiverMethods(node, paramName, XCONTENT_BUILDER_FLUENT_METHODS)
      ? 'XContentBuilder'
      : undefined;
  }

  private javaLambdaBodyUsesReceiverMethods(
    node: SyntaxNode,
    receiverName: string,
    methodNames: Set<string>,
  ): boolean {
    const visit = (candidate: SyntaxNode): boolean => {
      if (candidate.type === 'method_invocation') {
        const objectNode = candidate.childForFieldName('object');
        const methodName = candidate.childForFieldName('name')?.text;
        if (objectNode?.text === receiverName && methodName && methodNames.has(methodName)) return true;
      }
      return candidate.children.some(child => visit(child));
    };
    return visit(node);
  }

  private isJavaTypeVisible(typeName: string): boolean {
    if (this.currentJavaImports.some(importPath => importPath === typeName || importPath.endsWith(`.${typeName}`))) return true;
    if (this.javaFieldsByClass.has(typeName) || this.javaAccessorReturnsByClass.has(typeName)) return true;
    const currentFilePath = this.currentJavaFilePath;
    if (!currentFilePath) return false;
    const currentDir = path.dirname(currentFilePath);
    return this.javaConstantCandidatePaths(typeName, currentDir, this.currentJavaSourceRoots, this.currentJavaImports)
      .some(candidatePath => {
        try {
          const stat = fs.statSync(candidatePath);
          return stat.isFile();
        } catch {
          return false;
        }
      });
  }

  private inferJavaLambdaCastParamType(node: SyntaxNode): string | undefined {
    if (node.type !== 'lambda_expression') return undefined;
    const argumentList = node.parent;
    if (!argumentList || argumentList.type !== 'argument_list') return undefined;
    const invocation = argumentList.parent;
    if (!invocation || invocation.type !== 'method_invocation') return undefined;
    const previous = invocation.childForFieldName('object');
    if (!previous || previous.type !== 'method_invocation') return undefined;
    const previousName = previous.childForFieldName('name');
    if (!previousName || previousName.text !== 'map') return undefined;
    const previousArgs = previous.childForFieldName('arguments');
    const mapper = previousArgs?.namedChildren[0];
    if (!mapper || mapper.type !== 'method_reference') return undefined;
    const match = mapper.text.match(/^([A-Z][A-Za-z0-9_$.]*)\.class::cast$/);
    return match?.[1] ? simpleTypeName(match[1]) : undefined;
  }

  private inferJavaStreamLambdaParamType(
    node: SyntaxNode,
    receiverTypes?: Map<string, string>,
    enclosingClass?: string,
  ): string | undefined {
    if (node.type !== 'lambda_expression') return undefined;
    const argumentList = node.parent;
    if (!argumentList || argumentList.type !== 'argument_list') return undefined;
    const invocation = argumentList.parent;
    if (!invocation || invocation.type !== 'method_invocation') return undefined;
    const objectNode = invocation.childForFieldName('object');
    return this.inferJavaStreamElementType(objectNode, receiverTypes, enclosingClass);
  }

  private inferJavaStreamElementType(
    node: SyntaxNode | null | undefined,
    receiverTypes?: Map<string, string>,
    enclosingClass?: string,
  ): string | undefined {
    if (!node) return undefined;
    if (node.type === 'method_invocation') {
      const methodName = node.childForFieldName('name')?.text;
      const objectNode = node.childForFieldName('object');
      if (!methodName) return undefined;
      if (methodName === 'stream') {
        return extractJavaCollectionElementType(this.resolveJavaExpressionTypeText(objectNode, receiverTypes, enclosingClass));
      }
      if (methodName === 'filter' || methodName === 'peek' || methodName === 'distinct' || methodName === 'sorted' || methodName === 'limit' || methodName === 'skip') {
        return this.inferJavaStreamElementType(objectNode, receiverTypes, enclosingClass);
      }
      if (methodName === 'map') {
        const argsNode = node.childForFieldName('arguments');
        const mapper = argsNode?.namedChildren[0];
        if (mapper?.type === 'method_reference') {
          const castType = mapper.text.match(/^([A-Z][A-Za-z0-9_$.]*)\.class::cast$/)?.[1];
          if (castType) return simpleTypeName(castType);
        }
        return undefined;
      }
    }
    return extractJavaCollectionElementType(this.resolveJavaExpressionTypeText(node, receiverTypes, enclosingClass));
  }

  private resolveJavaExpressionTypeText(
    node: SyntaxNode | null | undefined,
    receiverTypes?: Map<string, string>,
    enclosingClass?: string,
  ): string | undefined {
    if (!node) return undefined;
    if (node.type === 'identifier') {
      return receiverTypes?.get(node.text) ?? this.resolveJavaFieldTypeFromHierarchy(enclosingClass, node.text);
    }
    if (node.type === 'parenthesized_expression') {
      return node.namedChildren.length === 1
        ? this.resolveJavaExpressionTypeText(node.namedChildren[0], receiverTypes, enclosingClass)
        : undefined;
    }
    if (node.type === 'object_creation_expression') {
      return this.extractJavaTypeText(node.childForFieldName('type'))
        ?? this.extractJavaTypeText(node.namedChildren.find(child =>
          child.type === 'type_identifier'
          || child.type === 'generic_type'
          || child.type === 'scoped_type_identifier'
        ));
    }
    if (node.type === 'field_access') {
      const objectNode = node.childForFieldName('object');
      const fieldNode = node.childForFieldName('field')
        ?? [...node.namedChildren].reverse().find(child => child.type === 'identifier' || child.type === 'field_identifier');
      if (!fieldNode) return undefined;
      const receiverType = this.resolveJavaExpressionTypeText(objectNode, receiverTypes, enclosingClass);
      return receiverType ? this.resolveJavaRawFieldType(receiverType, fieldNode.text) : undefined;
    }
    if (node.type === 'method_invocation') {
      const methodName = node.childForFieldName('name')?.text;
      if (!methodName) return undefined;
      const objectNode = node.childForFieldName('object');
      if (!objectNode) return undefined;
      const explicitReceiverType = this.resolveJavaExpressionTypeText(objectNode, receiverTypes, enclosingClass);
      const staticReceiver = explicitReceiverType ? undefined : objectNode.text;
      const receiverClass = explicitReceiverType
        ? simpleTypeName(explicitReceiverType)
        : staticReceiver && /^[A-Z]/.test(staticReceiver)
          ? simpleTypeName(staticReceiver)
          : undefined;
      if (receiverClass === 'XContentBuilder' && XCONTENT_BUILDER_FLUENT_METHODS.has(methodName)) return 'XContentBuilder';
      return receiverClass ? this.resolveJavaAccessorReturnType(receiverClass, methodName) : undefined;
    }
    return undefined;
  }

  private collectJavaStaticImport(node: SyntaxNode): void {
    const match = node.text.match(/^\s*import\s+static\s+([A-Za-z0-9_$.]+)\s*;\s*$/);
    if (!match) return;
    const importPath = match[1];
    if (!importPath || importPath.endsWith('.*')) return;
    const dot = importPath.lastIndexOf('.');
    if (dot <= 0 || dot >= importPath.length - 1) return;
    const owner = simpleTypeName(importPath.substring(0, dot));
    const symbol = importPath.substring(dot + 1);
    if (!owner || !symbol || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(symbol)) return;
    const owners = this.javaStaticImports.get(symbol) ?? new Set<string>();
    owners.add(owner);
    this.javaStaticImports.set(symbol, owners);
  }

  private resolveJavaStaticImportCallee(methodName: string): string | undefined {
    const owners = this.javaStaticImports.get(methodName);
    if (!owners || owners.size !== 1) return undefined;
    const [owner] = [...owners];
    return owner ? `${owner}.${methodName}` : undefined;
  }

  private getLineText(lines: string[], row: number): string {
    return lines[row] ?? '';
  }

  private getSignatureLine(lines: string[], row: number): string {
    // Get the declaration line, stripping body
    const line = (lines[row] ?? '').trim();
    // Remove opening brace
    const braceIdx = line.indexOf('{');
    if (braceIdx > 0) return line.substring(0, braceIdx).trim();
    // Remove colon for Python
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0 && line.startsWith('def ')) return line.substring(0, colonIdx).trim();
    return line;
  }

  private getContextLines(lines: string[], row: number, contextSize: number): string {
    const start = Math.max(0, row - contextSize);
    const end = Math.min(lines.length - 1, row + contextSize);
    return lines.slice(start, end + 1).join('\n');
  }
}

function isJavaIdentifierReferenceCandidate(node: SyntaxNode): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (parent.type === 'field_access') return false;
  if (parent.type === 'method_invocation' && sameSyntaxNode(parent.childForFieldName('name'), node)) return false;
  if (parent.type === 'variable_declarator' && sameSyntaxNode(parent.childForFieldName('name'), node)) return false;
  if (parent.type === 'formal_parameter' && sameSyntaxNode(parent.childForFieldName('name'), node)) return false;
  if (parent.type === 'spread_parameter' && sameSyntaxNode(parent.childForFieldName('name'), node)) return false;
  if (parent.type === 'class_declaration' && sameSyntaxNode(parent.childForFieldName('name'), node)) return false;
  if (parent.type === 'interface_declaration' && sameSyntaxNode(parent.childForFieldName('name'), node)) return false;
  if (parent.type === 'method_declaration' && sameSyntaxNode(parent.childForFieldName('name'), node)) return false;
  if (parent.type === 'constructor_declaration' && sameSyntaxNode(parent.childForFieldName('name'), node)) return false;
  if (parent.type === 'package_declaration' || parent.type === 'import_declaration') return false;
  if (parent.type === 'scoped_identifier' || parent.type === 'scoped_type_identifier') return false;
  return true;
}

function isCallbackValuePosition(node: SyntaxNode): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (parent.type === 'arguments' || parent.type === 'argument_list') return true;
  if (parent.type === 'argument' || parent.type === 'value_argument' || parent.type === 'parenthesized_expression') {
    return isCallbackValuePosition(parent);
  }
  if (parent.type === 'pair') return true;
  if (parent.type === 'keyword_argument') return sameSyntaxNode(parent.childForFieldName('value'), node);
  if (parent.type === 'assignment_expression' || parent.type === 'assignment') {
    return sameSyntaxNode(parent.childForFieldName('right'), node);
  }
  return false;
}

function javaFieldAccessKind(node: SyntaxNode, isConstructor: boolean, ownClassField: boolean): FieldAccessKind {
  const parent = node.parent;
  if (!parent) return 'unknown';
  if (parent.type === 'update_expression') return 'read_write';
  if (parent.type === 'assignment_expression' && syntaxNodeContains(parent.childForFieldName('left'), node)) {
    const operator = parent.childForFieldName('operator')?.text ?? assignmentOperatorFromText(parent.text);
    if (operator === '=') return isConstructor && ownClassField ? 'init' : 'write';
    return 'read_write';
  }
  return 'read';
}

function assignmentOperatorFromText(text: string): string | undefined {
  const match = text.match(/([+\-*/%&|^]?=)/);
  return match?.[1];
}

function sameSyntaxNode(left: SyntaxNode | null | undefined, right: SyntaxNode | null | undefined): boolean {
  return Boolean(left && right && left.startIndex === right.startIndex && left.endIndex === right.endIndex && left.type === right.type);
}

function syntaxNodeContains(parent: SyntaxNode | null | undefined, child: SyntaxNode): boolean {
  if (!parent) return false;
  return child.startIndex >= parent.startIndex && child.endIndex <= parent.endIndex;
}

function normalizeJavaTypeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function javaBeanGetterName(fieldName: string, fieldType: string): string {
  const capitalized = fieldName.length > 0
    ? fieldName[0]!.toUpperCase() + fieldName.slice(1)
    : fieldName;
  if (fieldType === 'boolean' && /^is[A-Z]/.test(fieldName)) return fieldName;
  return `get${capitalized}`;
}

function resolveReceiverType(receiver: string, receiverTypes?: Map<string, string>): string | undefined {
  if (!receiverTypes) return undefined;
  if (receiverTypes.has(receiver)) return receiverTypes.get(receiver);
  const lastSegment = receiver.split('.').pop();
  return lastSegment ? receiverTypes.get(lastSegment) : undefined;
}

function extractJavaCollectionElementType(typeName: string | undefined): string | undefined {
  if (!typeName) return undefined;
  const normalized = normalizeJavaTypeText(typeName);
  const arrayMatch = normalized.match(/^([A-Za-z_$][A-Za-z0-9_$.]*)\[\]$/);
  if (arrayMatch?.[1]) return simpleTypeName(arrayMatch[1]);
  const genericMatch = normalized.match(/^(?:[A-Za-z_$][A-Za-z0-9_$.]*)\s*<\s*(.+)\s*>$/);
  if (!genericMatch?.[1]) return undefined;
  let firstArg = genericMatch[1].trim();
  const comma = firstArg.indexOf(',');
  if (comma >= 0) firstArg = firstArg.slice(0, comma).trim();
  firstArg = firstArg.replace(/^\?\s*(?:extends|super)\s+/, '').trim();
  return firstArg ? simpleTypeName(firstArg) : undefined;
}

function splitTopLevelJavaGenericArgs(value: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === '<') depth++;
    if (char === '>') depth = Math.max(0, depth - 1);
    if (char === ',' && depth === 0) {
      args.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  const last = value.slice(start).trim();
  if (last) args.push(last);
  return args;
}

function javaGenericArgumentSimpleType(value: string): string | undefined {
  const normalized = normalizeJavaTypeText(value)
    .replace(/^\?\s*(?:extends|super)\s+/, '')
    .trim();
  if (!normalized || normalized === '?') return undefined;
  return simpleTypeName(normalized);
}

function javaTypeMembersContainClass(members: JavaTypeMembers, className: string): boolean {
  const simpleClassName = simpleTypeName(className);
  return members.accessorsByClass.has(simpleClassName)
    || members.fieldsByClass.has(simpleClassName)
    || members.functionalParamTypesByClass.has(simpleClassName)
    || members.superClassByClass.has(simpleClassName);
}

function isLikelyJavaRepoRoot(dir: string): boolean {
  return [
    '.git',
    'settings.gradle',
    'settings.gradle.kts',
    'pom.xml',
    'build.gradle',
    'build.gradle.kts',
  ].some(name => fs.existsSync(path.join(dir, name)));
}

function discoverJavaSourceRootsUnder(baseDir: string, maxDepth: number): string[] {
  const cacheKey = `${path.resolve(baseDir)}\0${maxDepth}`;
  const cached = javaSourceRootDiscoveryCache.get(cacheKey);
  if (cached) return cached;

  const roots = new Set<string>();
  const skippedDirs = new Set([
    '.codegraph',
    '.git',
    '.gradle',
    '.idea',
    '.tmp',
    'build',
    'dist',
    'node_modules',
    'out',
    'target',
  ]);
  const javaSourceSuffixes = [
    ['src', 'main', 'java'],
    ['src', 'test', 'java'],
    ['src', 'integration-test', 'java'],
    ['src', 'java'],
  ];

  const visit = (dir: string, depth: number): void => {
    for (const suffix of javaSourceSuffixes) {
      const sourceRoot = path.join(dir, ...suffix);
      if (fs.existsSync(sourceRoot)) roots.add(sourceRoot);
    }
    if (depth <= 0) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || skippedDirs.has(entry.name)) continue;
      visit(path.join(dir, entry.name), depth - 1);
    }
  };

  visit(baseDir, maxDepth);
  const result = [...roots];
  javaSourceRootDiscoveryCache.set(cacheKey, result);
  return result;
}

function resolveJavaInvocationReceiver(receiver: string, receiverTypes?: Map<string, string>): string | undefined {
  const direct = resolveReceiverType(receiver, receiverTypes);
  if (direct) return direct;
  if (!receiverTypes) return undefined;
  const parts = receiver.split('.');
  if (parts.length < 2 || parts.some(part => !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(part))) return undefined;
  const headType = receiverTypes.get(parts[0] ?? '');
  if (!headType) return undefined;
  return `${simpleTypeName(headType)}.${parts.slice(1).join('.')}`;
}

function simpleTypeName(typeName: string): string {
  const normalized = typeName.trim().replace(/<.*$/, '');
  const lastDot = normalized.lastIndexOf('.');
  return lastDot >= 0 ? normalized.substring(lastDot + 1) : normalized;
}

function treeSitterParseOptions(contentLength: number): { bufferSize: number } | undefined {
  if (contentLength <= 32 * 1024) return undefined;
  return {
    bufferSize: Math.min(Math.max(contentLength + 1024, 128 * 1024), 8 * 1024 * 1024),
  };
}
