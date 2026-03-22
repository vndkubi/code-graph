import { z } from 'zod';
import type { FileIndexer } from '../index/file-indexer.js';
import type { SymbolInfo } from '../analyzers/base-analyzer.js';
import { computeIndexConfidence, roundConfidence } from '../utils/confidence.js';

export const FindFieldShadowsSchema = z.object({
  className: z.string().optional()
    .describe('Check a specific class. Omit to scan entire codebase.'),
  includeTests: z.boolean().default(false).describe('Include test files in analysis.'),
  limit: z.number().min(1).max(500).default(100).describe('Max results.'),
});

export type FindFieldShadowsInput = z.infer<typeof FindFieldShadowsSchema>;

interface ClassInfo {
  name: string;
  file: string;
  line: number;
  extends?: string;
  fields: Array<{ name: string; type?: string; line: number; visibility: string }>;
  annotations?: string[];
  kind: string;
}

interface AncestorField {
  fieldName: string;
  fieldType?: string;
  declaredIn: string;
  declaredInFile: string;
  declaredAtLine: number;
  visibility: string;
}

const SERIALIZATION_ANNOTATIONS = new Set([
  'jsonproperty', 'jsonignore', 'jsontypeinfo', 'jsondeserialize', 'jsonserialize',
  'xmlelement', 'xmlattribute', 'xmlrootelement',
  'serializable',
  'entity', 'table', 'column', 'embeddable',
  'requestbody', 'responsebody',
  'data', 'value', // Lombok
]);

function getAncestorFields(className: string, classMap: Map<string, ClassInfo[]>, visited = new Set<string>()): AncestorField[] {
  if (visited.has(className)) return [];
  visited.add(className);

  const classInfos = classMap.get(className);
  if (!classInfos || classInfos.length === 0) return [];

  const result: AncestorField[] = [];
  for (const info of classInfos) {
    for (const field of info.fields) {
      result.push({
        fieldName: field.name,
        fieldType: field.type,
        declaredIn: info.name,
        declaredInFile: info.file,
        declaredAtLine: field.line,
        visibility: field.visibility,
      });
    }
    if (info.extends) {
      result.push(...getAncestorFields(info.extends, classMap, visited));
    }
  }
  return result;
}

function isAbstractClass(className: string, classMap: Map<string, ClassInfo[]>, allSymbols: readonly SymbolInfo[]): boolean {
  const infos = classMap.get(className);
  if (infos?.some(info => info.kind === 'interface')) return true;
  return allSymbols.some(s =>
    s.name === className &&
    (s.kind === 'class' || s.kind === 'interface') &&
    /\babstract\b/.test(s.signature)
  );
}

function hasSerializationAnnotations(cls?: { annotations?: string[] }): boolean {
  if (!cls?.annotations) return false;
  return cls.annotations.some(a => SERIALIZATION_ANNOTATIONS.has(a.toLowerCase()));
}

/**
 * Detect field shadowing in class hierarchies.
 *
 * A field shadow occurs when a child class declares a field with the same name
 * as a field in its parent (or ancestor) class. This can cause subtle bugs:
 * - In Java (especially with frameworks like Jackson/Spring), deserialization may
 *   set the parent field while the child reads its own (or vice versa), silently
 *   losing data.
 * - Abstract class fields shadowed by concrete subclasses break polymorphic behavior.
 */
export async function findFieldShadows(input: FindFieldShadowsInput, indexer: FileIndexer) {
  await indexer.ensureIndexed();

  const symbolIndex = indexer.getSymbolIndex();
  const { confidence: indexConfidence, confidenceNotes } = computeIndexConfidence(indexer);

  const allSymbols = symbolIndex.getAllSymbols();

  // Build class hierarchy
  const classMap = new Map<string, ClassInfo[]>();
  const classSymbols = allSymbols.filter(s => s.kind === 'class' || s.kind === 'interface');

  for (const cls of classSymbols) {
    if (!input.includeTests) {
      const lower = cls.file.toLowerCase();
      if (lower.includes('test') || lower.includes('spec') || lower.includes('__tests__')) continue;
    }

    const fields = allSymbols
      .filter(s => s.kind === 'field' && s.parent === cls.name && s.file === cls.file)
      .map(s => ({ name: s.name, type: s.returnType, line: s.line, visibility: s.visibility }));

    const info: ClassInfo = {
      name: cls.name,
      file: cls.file,
      line: cls.line,
      extends: cls.extends,
      fields,
      annotations: cls.annotations,
      kind: cls.kind,
    };

    if (!classMap.has(cls.name)) classMap.set(cls.name, []);
    classMap.get(cls.name)!.push(info);
  }

  const shadows: Array<{
    className: string;
    classFile: string;
    classLine: number;
    fieldName: string;
    fieldType?: string;
    fieldLine: number;
    shadowedFrom: string;
    shadowedFromFile: string;
    shadowedFromLine: number;
    shadowedFieldType?: string;
    severity: 'high' | 'medium' | 'low';
    reason: string;
  }> = [];

  // Check each class that extends something
  const classesToCheck = input.className
    ? (classMap.get(input.className) ?? [])
    : [...classMap.values()].flat();

  for (const cls of classesToCheck) {
    if (shadows.length >= input.limit) break;
    if (!cls.extends) continue;

    const ancestorFields = getAncestorFields(cls.extends, classMap);

    for (const field of cls.fields) {
      const shadowed = ancestorFields.find(af => af.fieldName === field.name);
      if (!shadowed) continue;

      let severity: 'high' | 'medium' | 'low' = 'medium';
      let reason = `Field "${field.name}" in ${cls.name} shadows field in ${shadowed.declaredIn}`;

      if (field.type && shadowed.fieldType && field.type !== shadowed.fieldType) {
        severity = 'high';
        reason += ` — types differ (${field.type} vs ${shadowed.fieldType}), likely data loss during serialization/deserialization`;
      } else if (isAbstractClass(shadowed.declaredIn, classMap, allSymbols)) {
        severity = 'high';
        reason += ` — parent is abstract, subclass field will shadow parent causing polymorphic data loss (e.g. Jackson/Spring deserialization)`;
      } else if (hasSerializationAnnotations(cls) || hasSerializationAnnotations(classMap.get(shadowed.declaredIn)?.[0])) {
        severity = 'high';
        reason += ` — class uses serialization annotations, shadowed field may cause silent data loss in API requests/responses`;
      } else if (shadowed.visibility === 'private') {
        severity = 'low';
        reason += ` — parent field is private, shadowing may be intentional`;
      }

      shadows.push({
        className: cls.name,
        classFile: cls.file,
        classLine: cls.line,
        fieldName: field.name,
        fieldType: field.type,
        fieldLine: field.line,
        shadowedFrom: shadowed.declaredIn,
        shadowedFromFile: shadowed.declaredInFile,
        shadowedFromLine: shadowed.declaredAtLine,
        shadowedFieldType: shadowed.fieldType,
        severity,
        reason,
      });
    }
  }

  const severityOrder = { high: 0, medium: 1, low: 2 };
  shadows.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  return {
    shadows: shadows.slice(0, input.limit),
    totalFound: shadows.length,
    truncated: shadows.length >= input.limit,
    summary: {
      high: shadows.filter(s => s.severity === 'high').length,
      medium: shadows.filter(s => s.severity === 'medium').length,
      low: shadows.filter(s => s.severity === 'low').length,
    },
    confidence: roundConfidence(indexConfidence),
    confidenceNotes: [
      ...confidenceNotes,
      'Field shadow detection depends on class hierarchy resolution — only detects shadows where extends is statically resolvable',
    ],
  };
}
