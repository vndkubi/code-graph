import { z } from 'zod';
import type { FileIndexer } from '../index/file-indexer.js';

export const GetModuleGraphSchema = z.object({
  format: z.enum(['json', 'mermaid', 'dot']).default('json').describe('Output format.'),
  includeExternal: z.boolean().default(false).describe('Include third-party dependencies.'),
  filterLayer: z.string().optional().describe('Only include modules of this layer type.'),
});

export type GetModuleGraphInput = z.infer<typeof GetModuleGraphSchema>;

export async function getModuleGraph(input: GetModuleGraphInput, indexer: FileIndexer) {
  await indexer.ensureIndexed();

  const graph = indexer.getDependencyGraph();
  let nodes = graph.getAllNodes();
  let edges = graph.getAllEdges();

  // Filter by layer
  if (input.filterLayer) {
    const layerFilter = input.filterLayer.toLowerCase();
    nodes = nodes.filter(n => n.layer === layerFilter);
    const nodeIds = new Set(nodes.map(n => n.id));
    edges = edges.filter(e => nodeIds.has(e.from) && nodeIds.has(e.to));
  }

  if (input.format === 'mermaid') {
    return { content: generateMermaid(nodes, edges) };
  }

  if (input.format === 'dot') {
    return { content: generateDot(nodes, edges) };
  }

  // JSON format
  return {
    nodes: nodes.map(n => ({
      id: n.id,
      name: n.name,
      type: n.type,
      layer: n.layer,
      path: n.path,
      riskLevel: getRiskLevel(graph.getInDegree(n.id)),
      inDegree: graph.getInDegree(n.id),
      outDegree: graph.getOutDegree(n.id),
    })),
    edges: edges.map(e => ({
      from: e.from,
      to: e.to,
      type: e.type,
    })),
    metadata: {
      totalNodes: nodes.length,
      totalEdges: edges.length,
      generatedAt: new Date().toISOString(),
    },
  };
}

function getRiskLevel(inDegree: number): 'high' | 'medium' | 'low' {
  if (inDegree >= 5) return 'high';
  if (inDegree >= 2) return 'medium';
  return 'low';
}

function generateMermaid(nodes: Array<{ id: string; name: string; layer: string }>, edges: Array<{ from: string; to: string }>): string {
  const lines: string[] = ['graph TD'];

  // classDef for coloring
  lines.push('  classDef api fill:#f9f,stroke:#333');
  lines.push('  classDef service fill:#bbf,stroke:#333');
  lines.push('  classDef repository fill:#bfb,stroke:#333');
  lines.push('  classDef domain fill:#fbb,stroke:#333');
  lines.push('  classDef other fill:#ddd,stroke:#333');

  const sanitize = (id: string) => id.replace(/[^a-zA-Z0-9_]/g, '_');

  for (const node of nodes) {
    const sid = sanitize(node.id);
    lines.push(`  ${sid}["${node.name}"]:::${node.layer || 'other'}`);
  }

  for (const edge of edges) {
    lines.push(`  ${sanitize(edge.from)} --> ${sanitize(edge.to)}`);
  }

  return lines.join('\n');
}

function generateDot(nodes: Array<{ id: string; name: string }>, edges: Array<{ from: string; to: string }>): string {
  const lines: string[] = ['digraph CodeGraph {', '  rankdir=TB;'];

  const sanitize = (id: string) => `"${id.replace(/"/g, '\\"')}"`;

  for (const node of nodes) {
    lines.push(`  ${sanitize(node.id)} [label=${sanitize(node.name)}];`);
  }

  for (const edge of edges) {
    lines.push(`  ${sanitize(edge.from)} -> ${sanitize(edge.to)};`);
  }

  lines.push('}');
  return lines.join('\n');
}
