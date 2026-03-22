import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { FileIndexer } from '../index/file-indexer.js';
import type { ParseResult, SymbolInfo } from '../analyzers/base-analyzer.js';
import { TreeSitterAnalyzer } from '../analyzers/tree-sitter-analyzer.js';
import { isSourceFile } from '../analyzers/language-detector.js';
import { guardPath, toRelativePath } from '../utils/path-guard.js';
import { computeIndexConfidence, roundConfidence } from '../utils/confidence.js';
import { detectLayer } from '../utils/layer-detection.js';
import { checkLayerViolations } from './check-layer-violations.js';
import { findFieldShadows } from './find-field-shadows.js';

export interface LayerRule {
  from: string;
  forbiddenDeps: string[];
}

export interface ChangedFilesOptions {
  files?: string[];
  baseRef?: string;
  headRef?: string;
  includeUntracked?: boolean;
}

export interface ChangedFilesSelection {
  changedFiles: string[];
  deletedFiles: string[];
  skippedNonSourceFiles: string[];
  detectionMode: 'explicit' | 'git-diff' | 'workspace';
  baseRefUsed?: string;
  headRefUsed?: string;
}

export interface ArchitecturalViolation {
  file: string;
  fileLayer: string;
  dependsOn: string;
  dependsOnLayer: string;
  rule: string;
  severity: 'high' | 'medium' | 'low';
}

export interface ArchitecturalDeltaResult {
  changedFiles: string[];
  detectionMode: string;
  baseRef?: string;
  headRef?: string;
  currentViolations: ArchitecturalViolation[];
  likelyNewViolations: ArchitecturalViolation[];
  addedDependencyRisks: Array<ArchitecturalViolation & { previousState: string }>;
  deletedFiles: string[];
  skippedNonSourceFiles: string[];
  confidence: number;
  confidenceNotes: string[];
}

export interface EndpointImpact {
  method: string;
  path: string;
  handler: string;
  file: string;
  line: number;
  impactedBy: string[];
  viaFiles: string[];
}

export interface ReviewFileDetail {
  file: string;
  layer: string;
  priority: 'high' | 'medium' | 'low';
  riskScore: number;
  reasons: string[];
  metrics: {
    directDependents: number;
    transitiveDependents: number;
    directDependencies: number;
    callerCount: number;
    calleeCount: number;
    endpointImpactCount: number;
    externalTypeUsageCount: number;
    deadCodeCandidateCount: number;
    fieldShadowCount: number;
    currentLayerViolationCount: number;
    likelyNewLayerViolationCount: number;
  };
  summary: {
    classCount: number;
    methodCount: number;
    fieldCount: number;
    importCount: number;
  };
  impactedEndpoints: EndpointImpact[];
  externallyUsedTypes: Array<{ typeName: string; usageCount: number; sampleFiles: string[] }>;
  likelyDeadSymbols: Array<{ symbol: string; kind: string; reason: string }>;
  fieldShadowFindings: Array<{ className: string; fieldName: string; severity: string; reason: string }>;
}

export interface DeletedFileImpact {
  file: string;
  layer: string;
  priority: 'high' | 'medium' | 'low';
  riskScore: number;
  reasons: string[];
  affectedFiles: string[];
  impactedEndpoints: EndpointImpact[];
}

export interface ReviewChangedFilesResult {
  changedFiles: string[];
  detectionMode: string;
  deletedFiles: string[];
  skippedNonSourceFiles: string[];
  reviewOrder: Array<{
    file: string;
    layer: string;
    priority: 'high' | 'medium' | 'low';
    riskScore: number;
    reasons: string[];
  }>;
  fileReviews: ReviewFileDetail[];
  deletedFileImpacts: DeletedFileImpact[];
  impactedEndpoints: EndpointImpact[];
  architecturalDelta: ArchitecturalDeltaResult;
  confidence: number;
  confidenceNotes: string[];
}

interface EndpointSymbol {
  method: string;
  path: string;
  handler: string;
  file: string;
  line: number;
}

interface SymbolTypeUsage {
  file: string;
  symbol: string;
  context: 'field' | 'parameter' | 'return';
}

const HTTP_ENDPOINT_ANNOTATIONS = new Set([
  'getmapping',
  'postmapping',
  'putmapping',
  'deletemapping',
  'patchmapping',
  'requestmapping',
  'path',
]);

const ENTRY_POINT_ANNOTATIONS = new Set([
  'test', 'before', 'beforeeach', 'beforeall', 'after', 'aftereach', 'afterall',
  'setup', 'teardown',
  'bean', 'postconstruct', 'predestroy', 'scheduled', 'eventlistener',
  'main',
  'getmapping', 'postmapping', 'putmapping', 'deletemapping', 'patchmapping', 'requestmapping',
  'exceptionhandler', 'initbinder', 'modelattribute',
]);

const ENTRY_POINT_ROLES = new Set([
  'spring:endpoint', 'spring:rest-controller', 'spring:service',
  'jaxrs:endpoint', 'mvc:controller',
  'jakarta:web-servlet', 'jakarta:web-filter', 'jakarta:lifecycle',
  'test:test',
]);

export function resolveChangedFiles(rootDir: string, options: ChangedFilesOptions): ChangedFilesSelection {
  const includeUntracked = options.includeUntracked ?? true;
  let candidates: string[];
  let detectionMode: ChangedFilesSelection['detectionMode'];
  let baseRefUsed: string | undefined;
  let headRefUsed: string | undefined;

  if (options.files && options.files.length > 0) {
    candidates = normalizeInputFiles(rootDir, options.files);
    baseRefUsed = options.baseRef;
    headRefUsed = options.headRef;
    detectionMode = 'explicit';
  } else if (options.baseRef || options.headRef) {
    baseRefUsed = options.baseRef ?? 'HEAD';
    headRefUsed = options.headRef;
    candidates = getGitDiffFiles(rootDir, baseRefUsed, headRefUsed);
    if (!headRefUsed && includeUntracked) {
      candidates.push(...getUntrackedFiles(rootDir));
    }
    detectionMode = 'git-diff';
  } else {
    baseRefUsed = 'HEAD';
    candidates = [
      ...getGitDiffFiles(rootDir, 'HEAD', undefined),
      ...getUntrackedFiles(rootDir),
    ];
    detectionMode = 'workspace';
  }

  const changedFiles: string[] = [];
  const deletedFiles: string[] = [];
  const skippedNonSourceFiles: string[] = [];

  for (const file of uniqueNormalizedPaths(candidates)) {
    if (!isSourceFile(path.basename(file))) {
      skippedNonSourceFiles.push(file);
      continue;
    }

    const absolutePath = path.join(rootDir, file);
    if (!fs.existsSync(absolutePath)) {
      deletedFiles.push(file);
      continue;
    }

    changedFiles.push(file);
  }

  return {
    changedFiles,
    deletedFiles,
    skippedNonSourceFiles,
    detectionMode,
    baseRefUsed,
    headRefUsed,
  };
}

export async function buildArchitecturalDelta(
  indexer: FileIndexer,
  selection: ChangedFilesSelection,
  customRules?: LayerRule[],
): Promise<ArchitecturalDeltaResult> {
  await indexer.ensureIndexed();

  const { confidence: indexConfidence, confidenceNotes } = computeIndexConfidence(indexer);
  const current = await checkLayerViolations(customRules ? { customRules } : {}, indexer);
  const changedFileSet = new Set(selection.changedFiles.map(normalizeRepoPath));
  const currentViolations = current.violations.filter(v => changedFileSet.has(normalizeRepoPath(v.file)));
  const graph = indexer.getDependencyGraph();
  const compareRef = selection.baseRefUsed;
  const likelyNewViolations: ArchitecturalViolation[] = [];

  if (compareRef) {
    const analyzer = new TreeSitterAnalyzer();
    for (const file of selection.changedFiles) {
      const indexedFile = resolveIndexedFile(graph, file);
      const previousParse = getHistoricalParseResult(indexer.getRootDir(), compareRef, file, analyzer);
      if (!previousParse) {
        likelyNewViolations.push(...currentViolations.filter(v => normalizeRepoPath(v.file) === normalizeRepoPath(indexedFile)));
        continue;
      }

      const previousKeys = getHistoricalViolationKeys(previousParse, indexedFile, graph, customRules);
      for (const violation of currentViolations) {
        if (normalizeRepoPath(violation.file) !== normalizeRepoPath(indexedFile)) continue;
        const key = `${normalizeRepoPath(violation.file)}|${violation.dependsOnLayer}|${normalizeRepoPath(violation.dependsOn)}`;
        if (!previousKeys.has(key)) {
          likelyNewViolations.push(violation);
        }
      }
    }
  }

  const notes = [...confidenceNotes];
  if (!compareRef) {
    notes.push('No baseline ref available, so architectural delta is based on current changed files only');
  } else {
    notes.push(`Architectural delta compared current workspace against ${compareRef}`);
    notes.push('Historical imports are resolved against the current graph — renames/moves between refs may cause false positives or missed violations');
  }

  const normalizeViolation = (violation: ArchitecturalViolation): ArchitecturalViolation => ({
    ...violation,
    file: normalizeRepoPath(violation.file),
    dependsOn: normalizeRepoPath(violation.dependsOn),
  });

  return {
    changedFiles: selection.changedFiles,
    detectionMode: selection.detectionMode,
    baseRef: selection.baseRefUsed,
    headRef: selection.headRefUsed,
    currentViolations: currentViolations.map(normalizeViolation),
    likelyNewViolations: likelyNewViolations.map(normalizeViolation),
    addedDependencyRisks: likelyNewViolations.map(violation => ({
      ...normalizeViolation(violation),
      previousState: compareRef
        ? `No matching violation found in ${compareRef}`
        : 'No baseline ref available for comparison',
    })),
    deletedFiles: selection.deletedFiles,
    skippedNonSourceFiles: selection.skippedNonSourceFiles,
    confidence: roundConfidence(indexConfidence),
    confidenceNotes: notes,
  };
}

export async function buildReviewChangedFiles(
  indexer: FileIndexer,
  selection: ChangedFilesSelection,
  maxDepth: number,
  customRules?: LayerRule[],
): Promise<ReviewChangedFilesResult> {
  await indexer.ensureIndexed();

  const graph = indexer.getDependencyGraph();
  const callGraph = indexer.getCallGraph();
  const symbolIndex = indexer.getSymbolIndex();
  const allSymbols = symbolIndex.getAllSymbols();
  const endpointSymbols = getEndpointSymbols(allSymbols);
  const endpointMap = new Map<string, EndpointImpact>();
  // Build type usage map scoped to types declared in changed files
  const changedTypeNames = new Set(
    allSymbols
      .filter(sym =>
        (sym.kind === 'class' || sym.kind === 'interface' || sym.kind === 'type') &&
        selection.changedFiles.some(f => {
          const node = graph.findNode(f);
          return node?.id === sym.file || f === sym.file;
        })
      )
      .map(sym => sym.name)
  );
  const typeUsageMap = buildTypeUsageMap(allSymbols, changedTypeNames);
  // Scope field-shadow analysis to classes declared in changed files only
  const changedFileSet = new Set(selection.changedFiles.map(f => {
    const node = graph.findNode(f);
    return node?.id ?? f;
  }));
  // Collect classes declared in changed files AND their subclasses anywhere in the codebase.
  // This ensures that when a base class changes (adds/renames a field), subclasses in
  // unchanged files are still checked for shadowing regressions.
  const changedClassNameSet = new Set(
    allSymbols
      .filter(sym => (sym.kind === 'class' || sym.kind === 'interface') && changedFileSet.has(sym.file))
      .map(sym => sym.name)
  );
  const subclassesOfChanged = allSymbols
    .filter(sym =>
      (sym.kind === 'class' || sym.kind === 'interface') &&
      sym.extends !== undefined &&
      changedClassNameSet.has(sym.extends) &&
      !changedClassNameSet.has(sym.name)
    )
    .map(sym => sym.name);
  const classesToCheck = [...changedClassNameSet, ...subclassesOfChanged];
  const fieldShadowResults = await Promise.all(
    classesToCheck.map(className => findFieldShadows({ className, includeTests: false, limit: 50 }, indexer))
  );
  const fieldShadows = {
    shadows: fieldShadowResults.flatMap(r => r.shadows),
  };
  const architecturalDelta = await buildArchitecturalDelta(indexer, selection, customRules);
  const currentViolationsByFile = groupBy(architecturalDelta.currentViolations, violation => normalizeRepoPath(violation.file));
  const newViolationsByFile = groupBy(architecturalDelta.likelyNewViolations, violation => normalizeRepoPath(violation.file));

  const fileReviews: ReviewFileDetail[] = selection.changedFiles.map((requestedFile) => {
    const file = resolveIndexedFile(graph, requestedFile);
    const outputFile = normalizeRepoPath(file);
    const fileSymbols = symbolIndex.getByFile(file);
    const callableSymbols = fileSymbols.filter(sym => sym.kind === 'method' || sym.kind === 'function');
    const typeSymbols = fileSymbols.filter(sym => sym.kind === 'class' || sym.kind === 'interface' || sym.kind === 'type');
    const layer = graph.findNode(file)?.layer ?? detectLayer(file);
    const node = graph.findNode(file);
    const directDependents = graph.getDependents(file).length;
    const transitiveDependents = node ? graph.getTransitiveDependents(node.id, maxDepth).length : 0;
    const directDependencies = graph.getDependencies(file).length;
    const callerCount = countUniqueCallers(callGraph, callableSymbols);
    const calleeCount = countUniqueCallees(callGraph, callableSymbols);
    const externallyUsedTypes = typeSymbols
      .map(sym => {
        const usages = (typeUsageMap.get(sym.name) ?? []).filter(usage => normalizeRepoPath(usage.file) !== outputFile);
        const sampleFiles = [...new Set(usages.map(usage => normalizeRepoPath(usage.file)))].slice(0, 5);
        return {
          typeName: sym.name,
          usageCount: usages.length,
          sampleFiles,
        };
      })
      .filter(entry => entry.usageCount > 0)
      .sort((a, b) => b.usageCount - a.usageCount);
    const likelyDeadSymbols = getLikelyDeadSymbols(fileSymbols, graph, callGraph, file);
    const fieldShadowFindings = fieldShadows.shadows
      .filter(shadow => normalizeRepoPath(shadow.classFile) === outputFile || normalizeRepoPath(shadow.shadowedFromFile) === outputFile)
      .map(shadow => ({
        className: shadow.className,
        fieldName: shadow.fieldName,
        severity: shadow.severity,
        reason: shadow.reason,
      }));
    const impactedEndpoints = getImpactedEndpointsForFile(file, graph, endpointSymbols, maxDepth).map(impact => ({
      ...impact,
      file: normalizeRepoPath(impact.file),
      impactedBy: impact.impactedBy.map(normalizeRepoPath),
      viaFiles: impact.viaFiles.map(normalizeRepoPath),
    }));

    for (const impact of impactedEndpoints) {
      const key = `${impact.file}:${impact.line}:${impact.handler}`;
      const existing = endpointMap.get(key);
      if (existing) {
        mergeUnique(existing.impactedBy, impact.impactedBy);
        mergeUnique(existing.viaFiles, impact.viaFiles);
      } else {
        endpointMap.set(key, {
          ...impact,
          impactedBy: [...impact.impactedBy],
          viaFiles: [...impact.viaFiles],
        });
      }
    }

    const currentViolationCount = currentViolationsByFile.get(outputFile)?.length ?? 0;
    const newViolationCount = newViolationsByFile.get(outputFile)?.length ?? 0;
    const reasons: string[] = [];
    let riskScore = 0;

    riskScore += directDependents * 4;
    riskScore += Math.min(10, transitiveDependents) * 2;
    riskScore += impactedEndpoints.length * 5;
    riskScore += externallyUsedTypes.reduce((sum, item) => sum + Math.min(5, item.usageCount), 0);
    riskScore += callerCount;
    riskScore += Math.min(5, calleeCount);
    riskScore += fieldShadowFindings.filter(item => item.severity === 'high').length * 4;
    riskScore += currentViolationCount * 4;
    riskScore += newViolationCount * 6;
    if (layer === 'api') riskScore += 4;
    if (layer === 'service') riskScore += 2;

    if (impactedEndpoints.length > 0) reasons.push(`Impacts ${impactedEndpoints.length} endpoint(s)`);
    if (directDependents > 0) reasons.push(`Has ${directDependents} direct dependent file(s)`);
    if (transitiveDependents > directDependents) reasons.push(`Propagates to ${transitiveDependents} transitive dependent file(s)`);
    if (externallyUsedTypes.length > 0) reasons.push(`Declares ${externallyUsedTypes.length} externally used type(s)`);
    if (currentViolationCount > 0) reasons.push(`Touches ${currentViolationCount} current layer violation(s)`);
    if (newViolationCount > 0) reasons.push(`Likely introduces ${newViolationCount} new layer violation(s)`);
    if (fieldShadowFindings.length > 0) reasons.push(`Contains ${fieldShadowFindings.length} field-shadowing risk(s)`);
    if (likelyDeadSymbols.length > 0) reasons.push(`Contains ${likelyDeadSymbols.length} low-reach symbol(s) worth validating`);

    const priority = riskScore >= 18 || newViolationCount > 0 || impactedEndpoints.length > 0
      ? 'high'
      : riskScore >= 8
        ? 'medium'
        : 'low';

    return {
      file: outputFile,
      layer,
      priority,
      riskScore,
      reasons,
      metrics: {
        directDependents,
        transitiveDependents,
        directDependencies,
        callerCount,
        calleeCount,
        endpointImpactCount: impactedEndpoints.length,
        externalTypeUsageCount: externallyUsedTypes.reduce((sum, item) => sum + item.usageCount, 0),
        deadCodeCandidateCount: likelyDeadSymbols.length,
        fieldShadowCount: fieldShadowFindings.length,
        currentLayerViolationCount: currentViolationCount,
        likelyNewLayerViolationCount: newViolationCount,
      },
      summary: {
        classCount: fileSymbols.filter(sym => sym.kind === 'class' || sym.kind === 'interface').length,
        methodCount: fileSymbols.filter(sym => sym.kind === 'method' || sym.kind === 'function').length,
        fieldCount: fileSymbols.filter(sym => sym.kind === 'field' || sym.kind === 'variable').length,
        importCount: indexer.getImportIndex().getImportsOf(file).length,
      },
      impactedEndpoints,
      externallyUsedTypes,
      likelyDeadSymbols,
      fieldShadowFindings,
    };
  });

  // Analyze deleted files for impact.
  // After reindex the deleted file has no graph node, so we find direct importers
  // (which still exist on disk) and trace transitive dependents + endpoints through them.
  const importIndex = indexer.getImportIndex();
  const deletedFileImpacts: DeletedFileImpact[] = selection.deletedFiles.map((deletedFile) => {
    const normDeleted = normalizeRepoPath(deletedFile);
    const layer = detectLayer(normDeleted);
    const reasons: string[] = ['File was deleted'];

    // Find files that directly import the deleted file via the import index
    const basename = normDeleted.split('/').pop() ?? normDeleted;
    const basenameNoExt = basename.replace(/\.[^.]+$/, '');
    const directImporterPaths = new Set<string>();
    for (const variant of [normDeleted, basename, basenameNoExt]) {
      for (const imp of importIndex.getImporters(variant)) {
        directImporterPaths.add(normalizeRepoPath(imp.file));
      }
    }

    // Resolve each importer to a graph node so we can trace transitively
    const importerNodeIds: string[] = [];
    for (const importerPath of directImporterPaths) {
      if (importerPath === normDeleted) continue;
      const importerNode = graph.findNode(importerPath);
      if (importerNode) importerNodeIds.push(importerNode.id);
    }

    // Collect transitive dependents through the importers (the blast radius)
    const allAffectedIds = new Set<string>(importerNodeIds);
    for (const importerNodeId of importerNodeIds) {
      for (const dep of graph.getTransitiveDependents(importerNodeId, maxDepth)) {
        allAffectedIds.add(dep.nodeId);
      }
    }

    const affectedFiles = [...allAffectedIds]
      .map(id => { const n = graph.getNode(id); return n ? normalizeRepoPath(n.path) : id; })
      .filter(f => f !== normDeleted);

    // Find endpoints impacted through importers and their transitive dependents
    const deletedEndpoints: EndpointImpact[] = [];
    const seenEndpointKeys = new Set<string>();
    for (const importerNodeId of importerNodeIds) {
      const impacts = getImpactedEndpointsForFile(importerNodeId, graph, endpointSymbols, maxDepth);
      for (const impact of impacts) {
        const normalized = {
          ...impact,
          file: normalizeRepoPath(impact.file),
          impactedBy: [normDeleted],
          viaFiles: impact.viaFiles.map(normalizeRepoPath),
        };
        const key = `${normalized.file}:${normalized.line}:${normalized.handler}`;
        if (seenEndpointKeys.has(key)) continue;
        seenEndpointKeys.add(key);
        deletedEndpoints.push(normalized);
        const existing = endpointMap.get(key);
        if (existing) {
          mergeUnique(existing.impactedBy, normalized.impactedBy);
          mergeUnique(existing.viaFiles, normalized.viaFiles);
        } else {
          endpointMap.set(key, { ...normalized, impactedBy: [...normalized.impactedBy], viaFiles: [...normalized.viaFiles] });
        }
      }
    }

    let riskScore = 20; // Deletions are inherently high-risk
    riskScore += directImporterPaths.size * 5;
    riskScore += Math.min(10, allAffectedIds.size - importerNodeIds.length) * 2;
    riskScore += deletedEndpoints.length * 5;
    if (layer === 'api') riskScore += 6;
    if (layer === 'service') riskScore += 4;
    if (layer === 'domain') riskScore += 4;

    if (directImporterPaths.size > 0) reasons.push(`${directImporterPaths.size} file(s) directly import this module`);
    if (affectedFiles.length > directImporterPaths.size) reasons.push(`${affectedFiles.length} total file(s) in transitive blast radius`);
    if (deletedEndpoints.length > 0) reasons.push(`Impacts ${deletedEndpoints.length} endpoint(s) via import chain`);

    return {
      file: normDeleted,
      layer,
      priority: 'high' as const,
      riskScore,
      reasons,
      affectedFiles,
      impactedEndpoints: deletedEndpoints,
    };
  });

  fileReviews.sort((a, b) => b.riskScore - a.riskScore);

  const impactedEndpoints = [...endpointMap.values()]
    .sort((a, b) => b.impactedBy.length - a.impactedBy.length || a.file.localeCompare(b.file));

  const { confidence: indexConfidence, confidenceNotes } = computeIndexConfidence(indexer);
  const notes = [...confidenceNotes];
  if (selection.deletedFiles.length > 0) {
    notes.push(`${selection.deletedFiles.length} deleted source file(s) analyzed for orphaned references and endpoint impact`);
  }
  if (selection.skippedNonSourceFiles.length > 0) {
    notes.push(`${selection.skippedNonSourceFiles.length} non-source changed file(s) were skipped`);
  }

  // Merge deleted file impacts into the review order alongside changed files
  const allReviewEntries = [
    ...fileReviews.map(review => ({
      file: review.file,
      layer: review.layer,
      priority: review.priority,
      riskScore: review.riskScore,
      reasons: review.reasons,
    })),
    ...deletedFileImpacts.map(impact => ({
      file: impact.file,
      layer: impact.layer,
      priority: impact.priority,
      riskScore: impact.riskScore,
      reasons: impact.reasons,
    })),
  ].sort((a, b) => b.riskScore - a.riskScore);

  return {
    changedFiles: selection.changedFiles,
    detectionMode: selection.detectionMode,
    deletedFiles: selection.deletedFiles,
    skippedNonSourceFiles: selection.skippedNonSourceFiles,
    reviewOrder: allReviewEntries,
    fileReviews,
    deletedFileImpacts,
    impactedEndpoints,
    architecturalDelta,
    confidence: roundConfidence(indexConfidence),
    confidenceNotes: notes,
  };
}

function normalizeInputFiles(rootDir: string, files: string[]): string[] {
  const normalized: string[] = [];
  for (const file of files) {
    try {
      const absolutePath = path.isAbsolute(file)
        ? guardPath(path.relative(rootDir, file), rootDir)
        : guardPath(file, rootDir);
      normalized.push(toRelativePath(absolutePath, rootDir).replace(/\\/g, '/'));
    } catch {
      // Ignore files outside the repo root.
    }
  }
  return normalized;
}

function getGitDiffFiles(rootDir: string, baseRef: string, headRef?: string): string[] {
  const args = ['diff', '--name-only', '--diff-filter=ACMRD'];
  if (headRef) {
    args.push(baseRef, headRef);
  } else {
    args.push(baseRef);
  }
  return runGitFileList(rootDir, args);
}

function getUntrackedFiles(rootDir: string): string[] {
  return runGitFileList(rootDir, ['ls-files', '--others', '--exclude-standard']);
}

function runGitFileList(rootDir: string, args: string[]): string[] {
  try {
    const output = execFileSync('git', args, {
      cwd: rootDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => line.replace(/\\/g, '/'));
  } catch {
    return [];
  }
}

function uniqueNormalizedPaths(files: string[]): string[] {
  return [...new Set(files.map(file => file.replace(/\\/g, '/')))];
}

function getHistoricalParseResult(
  rootDir: string,
  ref: string,
  file: string,
  analyzer: TreeSitterAnalyzer,
): ParseResult | undefined {
  const content = readFileFromGit(rootDir, ref, file);
  if (content === undefined) return undefined;
  return analyzer.parse(path.join(rootDir, file), content, rootDir);
}

function readFileFromGit(rootDir: string, ref: string, file: string): string | undefined {
  try {
    return execFileSync('git', ['show', `${ref}:${file.replace(/\\/g, '/')}`], {
      cwd: rootDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }
}

function getHistoricalViolationKeys(
  parseResult: ParseResult,
  file: string,
  graph: ReturnType<FileIndexer['getDependencyGraph']>,
  customRules?: LayerRule[],
): Set<string> {
  const fileLayer = detectLayer(file);
  const rules = customRules
    ? customRules.filter(rule => rule.from === fileLayer)
    : getDefaultRulesForLayer(fileLayer);
  const forbiddenLayers = new Set(rules.flatMap(rule => rule.forbiddenDeps));
  const keys = new Set<string>();

  for (const imp of parseResult.imports) {
    const target = resolveImportTarget(imp.source, file, graph);
    const targetLayer = target?.layer ?? detectLayer(imp.source);
    if (forbiddenLayers.has(targetLayer)) {
      keys.add(`${normalizeRepoPath(file)}|${targetLayer}|${normalizeRepoPath(target?.path ?? imp.source)}`);
    }
  }

  return keys;
}

function resolveImportTarget(
  source: string,
  fromFile: string,
  graph: ReturnType<FileIndexer['getDependencyGraph']>,
): { path: string; layer: string } | undefined {
  const normalizedFile = fromFile.replace(/\\/g, '/');

  if (source.startsWith('.')) {
    const dir = normalizedFile.substring(0, normalizedFile.lastIndexOf('/'));
    const parts = source.split('/');
    let resolved = dir;
    for (const part of parts) {
      if (part === '.' || part === '') continue;
      if (part === '..') {
        resolved = resolved.substring(0, resolved.lastIndexOf('/'));
      } else {
        resolved = resolved ? `${resolved}/${part}` : part;
      }
    }

    const candidate = graph.findNode(resolved)
      ?? graph.findNode(`${resolved}.ts`)
      ?? graph.findNode(`${resolved}.tsx`)
      ?? graph.findNode(`${resolved}.js`)
      ?? graph.findNode(`${resolved}.java`)
      ?? graph.findNode(`${resolved}.py`);
    if (candidate) return { path: candidate.path, layer: candidate.layer };
  }

  if (source.includes('.')) {
    const slashPath = source.replace(/\./g, '/');
    const candidate = graph.findNode(`${slashPath}.java`)
      ?? graph.findNode(`${slashPath}.py`)
      ?? graph.findNode(`${slashPath}.ts`)
      ?? graph.findNode(`${slashPath}.tsx`)
      ?? graph.findNode(slashPath);
    if (candidate) return { path: candidate.path, layer: candidate.layer };
  }

  const candidate = graph.findNode(source);
  return candidate ? { path: candidate.path, layer: candidate.layer } : undefined;
}

function resolveIndexedFile(
  graph: ReturnType<FileIndexer['getDependencyGraph']>,
  file: string,
): string {
  const node = graph.findNode(file);
  return node?.path ?? node?.id ?? file;
}

function normalizeRepoPath(file: string): string {
  return file.replace(/\\/g, '/');
}

function getDefaultRulesForLayer(layer: string): LayerRule[] {
  switch (layer) {
    case 'domain':
      return [{ from: 'domain', forbiddenDeps: ['api', 'service', 'repository', 'dto', 'config'] }];
    case 'repository':
      return [{ from: 'repository', forbiddenDeps: ['api', 'service'] }];
    case 'service':
      return [{ from: 'service', forbiddenDeps: ['api'] }];
    case 'dto':
      return [{ from: 'dto', forbiddenDeps: ['api', 'service', 'repository'] }];
    case 'utility':
      return [{ from: 'utility', forbiddenDeps: ['api', 'service', 'repository', 'domain'] }];
    default:
      return [];
  }
}

function getEndpointSymbols(symbols: readonly SymbolInfo[]): EndpointSymbol[] {
  const results: EndpointSymbol[] = [];
  const seen = new Set<string>();

  for (const sym of symbols) {
    const hasEndpointRole = sym.frameworkRole?.includes('endpoint') || sym.frameworkRole?.includes('controller');
    const hasEndpointAnnotation = sym.annotations?.some(annotation => HTTP_ENDPOINT_ANNOTATIONS.has(annotation.toLowerCase()));
    if (!hasEndpointRole && !hasEndpointAnnotation) continue;

    const key = `${sym.file}:${sym.line}:${sym.name}`;
    if (seen.has(key)) continue;
    seen.add(key);

    results.push({
      method: sym.frameworkMeta?.httpMethod ?? 'UNKNOWN',
      path: sym.frameworkMeta?.path ?? '',
      handler: sym.parent ? `${sym.parent}.${sym.name}` : sym.name,
      file: sym.file,
      line: sym.line,
    });
  }

  return results;
}

function getImpactedEndpointsForFile(
  file: string,
  graph: ReturnType<FileIndexer['getDependencyGraph']>,
  endpoints: EndpointSymbol[],
  maxDepth: number,
): EndpointImpact[] {
  const node = graph.findNode(file);
  const dependentFiles = new Set<string>([file]);
  const viaMap = new Map<string, string[]>();

  if (node) {
    for (const dependent of graph.getTransitiveDependents(node.id, maxDepth)) {
      const dependentNode = graph.getNode(dependent.nodeId);
      if (!dependentNode) continue;
      dependentFiles.add(dependentNode.path);
      viaMap.set(dependentNode.path, dependent.via);
    }
  }

  return endpoints
    .filter(endpoint => dependentFiles.has(endpoint.file))
    .map(endpoint => ({
      ...endpoint,
      impactedBy: [file],
      viaFiles: viaMap.get(endpoint.file) ?? (endpoint.file === file ? [file] : []),
    }));
}

/**
 * Build a map from type name to usages across all symbols.
 * If relevantTypeNames is provided, only tracks usages of those type names (scoped mode).
 */
function buildTypeUsageMap(symbols: readonly SymbolInfo[], relevantTypeNames?: Set<string>): Map<string, SymbolTypeUsage[]> {
  const usageMap = new Map<string, SymbolTypeUsage[]>();

  const pushUsage = (typeName: string, usage: SymbolTypeUsage): void => {
    if (relevantTypeNames && !relevantTypeNames.has(typeName)) return;
    const bucket = usageMap.get(typeName);
    if (bucket) {
      bucket.push(usage);
    } else {
      usageMap.set(typeName, [usage]);
    }
  };

  for (const sym of symbols) {
    const symbolName = sym.parent ? `${sym.parent}.${sym.name}` : sym.name;
    if (sym.kind === 'field' && sym.returnType) {
      pushUsage(sym.returnType, { file: sym.file, symbol: symbolName, context: 'field' });
    }
    if ((sym.kind === 'method' || sym.kind === 'function') && sym.returnType) {
      pushUsage(sym.returnType, { file: sym.file, symbol: symbolName, context: 'return' });
    }
    if ((sym.kind === 'method' || sym.kind === 'function') && sym.parameterTypes) {
      for (const parameterType of sym.parameterTypes) {
        pushUsage(parameterType, { file: sym.file, symbol: symbolName, context: 'parameter' });
      }
    }
  }

  return usageMap;
}

function countUniqueCallers(callGraph: ReturnType<FileIndexer['getCallGraph']>, symbols: SymbolInfo[]): number {
  const callers = new Set<string>();
  for (const sym of symbols) {
    const fullName = sym.parent ? `${sym.parent}.${sym.name}` : sym.name;
    for (const edge of callGraph.getCallers(fullName)) {
      callers.add(edge.from);
    }
  }
  return callers.size;
}

function countUniqueCallees(callGraph: ReturnType<FileIndexer['getCallGraph']>, symbols: SymbolInfo[]): number {
  const callees = new Set<string>();
  for (const sym of symbols) {
    const fullName = sym.parent ? `${sym.parent}.${sym.name}` : sym.name;
    for (const edge of callGraph.getCallees(fullName)) {
      callees.add(callGraph.resolveSymbol(edge.to) ?? edge.to);
    }
  }
  return callees.size;
}

function getLikelyDeadSymbols(
  symbols: SymbolInfo[],
  graph: ReturnType<FileIndexer['getDependencyGraph']>,
  callGraph: ReturnType<FileIndexer['getCallGraph']>,
  file: string,
): Array<{ symbol: string; kind: string; reason: string }> {
  const results: Array<{ symbol: string; kind: string; reason: string }> = [];

  for (const sym of symbols) {
    if (!['method', 'function', 'class'].includes(sym.kind)) continue;
    if (isEntryPoint(sym)) continue;

    const symbolName = sym.parent ? `${sym.parent}.${sym.name}` : sym.name;
    let hasCallers = callGraph.getCallers(symbolName).length > 0;

    if (!hasCallers) {
      for (const resolved of callGraph.resolveAllMatches(symbolName)) {
        if (callGraph.getCallers(resolved).length > 0) {
          hasCallers = true;
          break;
        }
      }
    }

    if (!hasCallers && sym.kind === 'class' && graph.getDependents(file).length > 0) {
      hasCallers = true;
    }

    if (!hasCallers) {
      results.push({
        symbol: symbolName,
        kind: sym.kind,
        reason: sym.kind === 'class'
          ? 'No dependent files were found for this class file'
          : 'No callers were found in the call graph',
      });
    }
  }

  return results.slice(0, 10);
}

export function isEntryPoint(sym: { annotations?: string[]; frameworkRole?: string; name: string }): boolean {
  if (sym.annotations?.some(annotation => ENTRY_POINT_ANNOTATIONS.has(annotation.toLowerCase()))) return true;
  if (sym.frameworkRole && ENTRY_POINT_ROLES.has(sym.frameworkRole)) return true;
  return ['main', 'run', 'start', 'init', 'destroy', 'close'].includes(sym.name.toLowerCase());
}

function groupBy<T, K>(items: T[], keyFn: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const bucket = map.get(key);
    if (bucket) {
      bucket.push(item);
    } else {
      map.set(key, [item]);
    }
  }
  return map;
}

function mergeUnique(target: string[], incoming: string[]): void {
  const seen = new Set(target);
  for (const item of incoming) {
    if (!seen.has(item)) {
      seen.add(item);
      target.push(item);
    }
  }
}
