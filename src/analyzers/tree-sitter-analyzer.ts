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
const EXTERNAL_JAVA_ANNOTATION_CONSTANT_PATTERN = /@\w+(?:\s*\([\s\S]{0,300}\b[A-Z][A-Za-z0-9_]*\s*\.\s*[A-Z][A-Za-z0-9_]*\b)/;

interface JavaFieldInfo {
  name: string;
  ownerClass: string;
  fieldFqName: string;
  type?: string;
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
export class TreeSitterAnalyzer implements CodeAnalyzer {
  readonly supportedExtensions = ['.java', '.ts', '.tsx', '.js', '.jsx', '.py'];
  private parser = new Parser();

  // Temporary accumulators reset on each parse() call (Java only)
  private parseTypeRefs: TypeRefInfo[] = [];
  private parseFieldUsages: FieldUsageInfo[] = [];
  private parsePackageName: string | undefined;
  private javaFieldsByClass = new Map<string, Map<string, JavaFieldInfo>>();
  private javaSuperClassByClass = new Map<string, string>();
  private javaStaticImports = new Map<string, Set<string>>();
  private javaStringConstants = new Map<string, string>();
  private externalJavaConstantCache = new Map<string, Map<string, string> | undefined>();

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
    this.javaSuperClassByClass = new Map();
    this.javaStaticImports = new Map();
    this.javaStringConstants = new Map();
    if (lang === 'java') {
      this.javaStringConstants = this.collectJavaStringConstants(tree.rootNode);
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
              this.extractJava(body, file, lines, symbols, imports, calls, references, nameNode.text);
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
              this.collectJavaLocalVariableTypes(body, receiverTypes, file, shadowedNames);
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
    const packagePrefix = this.parsePackageName ? `${this.parsePackageName}.` : '';
    for (const child of body.children) {
      if (child.type !== 'field_declaration') continue;
      const fieldType = this.extractJavaTypeName(child.childForFieldName('type')) ?? undefined;
      for (const declarator of child.children.filter(c => c.type === 'variable_declarator')) {
        const nameNode = declarator.childForFieldName('name') ?? declarator.children.find(c => c.type === 'identifier');
        if (!nameNode) continue;
        fields.set(nameNode.text, {
          name: nameNode.text,
          ownerClass: className,
          fieldFqName: `${packagePrefix}${className}.${nameNode.text}`,
          type: fieldType,
        });
      }
    }
    this.javaFieldsByClass.set(className, fields);
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
      for (const child of node.children) visit(child);
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
      for (const child of node.children) visit(child);
    };
    visit(root);
    return classNames;
  }

  private collectJavaImportPaths(root: SyntaxNode): string[] {
    const imports: string[] = [];
    const visit = (node: SyntaxNode): void => {
      if (node.type === 'import_declaration') {
        const match = node.text.match(/^import\s+(?:static\s+)?([\w.*]+)\s*;/);
        if (match?.[1]) imports.push(match[1]);
      }
      for (const child of node.children) visit(child);
    };
    visit(root);
    return imports;
  }

  private javaSourceRootsFor(filePath: string, rootDir: string): string[] {
    const roots = new Set<string>();
    const normalized = filePath.replace(/\\/g, '/');
    for (const marker of [
      '/src/main/java/',
      '/src/test/java/',
      '/src/integration-test/java/',
      '/src/java/',
    ]) {
      const index = normalized.indexOf(marker);
      if (index >= 0) {
        roots.add(filePath.slice(0, index + marker.length));
      }
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

    this.externalJavaConstantCache.set(absolute, constants);
    return constants;
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

    const meta: Record<string, string> = {};
    for (const child of node.children) {
      if (child.type !== 'modifiers') continue;
      for (const mod of child.children) {
        if (mod.type !== 'annotation') continue;
        const nameNode = mod.childForFieldName('name');
        if (!nameNode) continue;
        const rawName = nameNode.text;
        const simpleName = rawName.includes('.') ? rawName.substring(rawName.lastIndexOf('.') + 1) : rawName;
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
          if (val?.type === 'array_initializer') {
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

  /** Add local Java variable declarations to the receiver type scope. */
  private collectJavaLocalVariableTypes(
    node: SyntaxNode,
    receiverTypes: Map<string, string>,
    file: string,
    shadowedNames?: Set<string>,
  ): void {
    if (node.type === 'local_variable_declaration' || node.type === 'resource') {
      const typeName = this.extractJavaTypeName(node.childForFieldName('type'));
      if (typeName) {
        for (const declarator of node.children.filter(child => child.type === 'variable_declarator')) {
          const nameNode = declarator.childForFieldName('name') ?? declarator.children.find(child => child.type === 'identifier');
          if (nameNode) {
            receiverTypes.set(nameNode.text, typeName);
            shadowedNames?.add(nameNode.text);
          }
        }
        if (this.isReferenceType(typeName)) {
          this.parseTypeRefs.push({
            file,
            referencedType: typeName,
            context: 'parameter',
            line: node.startPosition.row + 1,
          });
        }
      }
    }
    for (const child of node.children) {
      this.collectJavaLocalVariableTypes(child, receiverTypes, file, shadowedNames);
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
              this.extractCallsFromNode(body, file, lines, calls, references, funcName, undefined, undefined, parentClass);
            }
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
                  this.extractCallsFromNode(value, file, lines, calls, references, funcName, undefined, undefined, parentClass);
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
              this.extractCallsFromNode(body, file, lines, calls, references, funcName, undefined, undefined, parentClass);
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
  ): void {
    if (this.maybeExtractJavaFieldUsageFromNode(node, file, lines, fieldUsageContext)) {
      return;
    }

    const callbackReference = this.resolveCallbackReferenceCallee(node, enclosingClass);
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
      return;
    }

    if (node.type === 'lambda_expression') {
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
        this.extractCallsFromNode(child, file, lines, calls, references, callbackName, receiverTypes, fieldUsageContext, enclosingClass);
      }
      return;
    }

    if ((node.type === 'arrow_function' || node.type === 'function_expression' || node.type === 'lambda') && isCallbackValuePosition(node)) {
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
        this.extractCallsFromNode(child, file, lines, calls, references, callbackName, receiverTypes, fieldUsageContext, enclosingClass);
      }
      return;
    }

    // Java: method invocation — obj.method(args)
    if (node.type === 'object_creation_expression') {
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

    if (node.type === 'method_invocation') {
      const funcNode = node.childForFieldName('name') ?? node.children[0];
      if (funcNode) {
        let calleeName = '';
        let resolutionKind: string | undefined;
        const objectNode = node.childForFieldName('object');
        if (objectNode) {
          const receiverType = resolveReceiverType(objectNode.text, receiverTypes);
          calleeName = `${receiverType ?? objectNode.text}.${funcNode.text}`;
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
    if (node.type === 'method_reference') {
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
    if (node.type === 'call_expression') {
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
    if (node.type === 'call') {
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

    for (const child of node.children) {
      this.extractCallsFromNode(child, file, lines, calls, references, callerName, receiverTypes, fieldUsageContext, enclosingClass);
    }
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
  ): string | undefined {
    return this.resolveScriptCallCallee(node, enclosingClass);
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
  if (parent.type === 'keyword_argument') return sameSyntaxNode(parent.childForFieldName('value'), node);
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

function resolveReceiverType(receiver: string, receiverTypes?: Map<string, string>): string | undefined {
  if (!receiverTypes) return undefined;
  if (receiverTypes.has(receiver)) return receiverTypes.get(receiver);
  const lastSegment = receiver.split('.').pop();
  return lastSegment ? receiverTypes.get(lastSegment) : undefined;
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
