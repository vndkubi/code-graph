import { z } from 'zod';
import type { FileIndexer } from '../index/file-indexer.js';

export const GetFileSummarySchema = z.object({
  file: z.string().describe('File path (relative or absolute, or just the filename).'),
});

export type GetFileSummaryInput = z.infer<typeof GetFileSummarySchema>;

export async function getFileSummary(input: GetFileSummaryInput, indexer: FileIndexer) {
  await indexer.ensureIndexed();

  const graph = indexer.getDependencyGraph();
  const symbolIndex = indexer.getSymbolIndex();
  const importIndex = indexer.getImportIndex();

  // Resolve file node
  const node = graph.findNode(input.file);
  if (!node) {
    return { error: `File "${input.file}" not found in index.` };
  }

  const fileId = node.id;

  // Symbols in this file
  const symbols = symbolIndex.getByFile(fileId);

  // Imports
  const imports = importIndex.getImportsOf(fileId);

  // Dependencies (what this file imports)
  const depEdges = graph.getDependencies(fileId);
  const dependencies = depEdges.map(e => {
    const depNode = graph.getNode(e.to);
    return { module: depNode?.path ?? e.to, weight: e.weight };
  });

  // Dependents (who imports this file)
  const depnEdges = graph.getDependents(fileId);
  const dependents = depnEdges.map(e => {
    const depNode = graph.getNode(e.from);
    return { module: depNode?.path ?? e.from, weight: e.weight };
  });

  // Classes and their hierarchy
  const classes = symbols
    .filter(s => s.kind === 'class' || s.kind === 'interface')
    .map(s => ({
      name: s.name,
      kind: s.kind,
      extends: s.extends,
      implements: s.implements,
      annotations: s.annotations,
      frameworkRole: s.frameworkRole,
      visibility: s.visibility,
      line: s.line,
    }));

  // Methods
  const methods = symbols
    .filter(s => s.kind === 'method' || s.kind === 'function')
    .map(s => ({
      name: s.parent ? `${s.parent}.${s.name}` : s.name,
      signature: s.signature,
      visibility: s.visibility,
      annotations: s.annotations,
      frameworkRole: s.frameworkRole,
      frameworkMeta: s.frameworkMeta,
      line: s.line,
    }));

  // Fields
  const fields = symbols
    .filter(s => s.kind === 'field' || s.kind === 'variable')
    .map(s => ({
      name: s.parent ? `${s.parent}.${s.name}` : s.name,
      type: s.returnType,
      visibility: s.visibility,
      annotations: s.annotations,
      isStatic: s.isStatic,
      line: s.line,
    }));

  return {
    file: fileId,
    layer: node.layer,
    packageName: symbols.find(s => s.packageName)?.packageName,
    classes,
    methods,
    fields,
    imports: imports.map(i => ({
      source: i.source,
      symbols: i.symbols,
      isExternal: i.isExternal,
      line: i.line,
    })),
    dependencies,
    dependents,
    stats: {
      classCount: classes.length,
      methodCount: methods.length,
      fieldCount: fields.length,
      importCount: imports.length,
      dependencyCount: dependencies.length,
      dependentCount: dependents.length,
    },
  };
}
