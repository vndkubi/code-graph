import { z } from 'zod';
import type { FileIndexer } from '../index/file-indexer.js';
import { computeIndexConfidence, roundConfidence } from '../utils/confidence.js';

export const CheckLayerViolationsSchema = z.object({
  customRules: z.array(z.object({
    from: z.string().describe('Source layer (e.g. "repository")'),
    forbiddenDeps: z.array(z.string()).describe('Layers that "from" should NOT depend on'),
  })).optional().describe('Custom layer rules. If omitted, uses standard layered architecture rules.'),
});

export type CheckLayerViolationsInput = z.infer<typeof CheckLayerViolationsSchema>;

/** Standard layered architecture rules: layer → forbidden dependency targets */
export const DEFAULT_LAYER_RULES: Array<{ from: string; forbiddenDeps: string[] }> = [
  // Domain should not depend on anything above it
  { from: 'domain', forbiddenDeps: ['api', 'service', 'repository', 'dto', 'config'] },
  // Repository should not depend on services or controllers
  { from: 'repository', forbiddenDeps: ['api', 'service'] },
  // Service should not depend on controllers
  { from: 'service', forbiddenDeps: ['api'] },
  // DTO should not depend on services, controllers, or repositories
  { from: 'dto', forbiddenDeps: ['api', 'service', 'repository'] },
  // Utility should not depend on business layers
  { from: 'utility', forbiddenDeps: ['api', 'service', 'repository', 'domain'] },
];

export async function checkLayerViolations(input: CheckLayerViolationsInput, indexer: FileIndexer) {
  await indexer.ensureIndexed();

  const graph = indexer.getDependencyGraph();
  const rules = input.customRules ?? DEFAULT_LAYER_RULES;
  const { confidence: indexConfidence, confidenceNotes } = computeIndexConfidence(indexer);

  const violations: Array<{
    file: string;
    fileLayer: string;
    dependsOn: string;
    dependsOnLayer: string;
    rule: string;
    severity: 'high' | 'medium' | 'low';
  }> = [];

  // Build layer map
  const allNodes = graph.getAllNodes();
  const nodeLayerMap = new Map<string, string>();
  for (const node of allNodes) {
    nodeLayerMap.set(node.id, node.layer);
  }

  // Check each rule
  for (const rule of rules) {
    // Find all nodes in the "from" layer
    const sourceNodes = allNodes.filter(n => n.layer === rule.from);
    const forbiddenSet = new Set(rule.forbiddenDeps);

    for (const sourceNode of sourceNodes) {
      const edges = graph.getDependencies(sourceNode.id);
      for (const edge of edges) {
        const targetLayer = nodeLayerMap.get(edge.to);
        if (targetLayer && forbiddenSet.has(targetLayer)) {
          const targetNode = graph.getNode(edge.to);
          violations.push({
            file: sourceNode.path,
            fileLayer: rule.from,
            dependsOn: targetNode?.path ?? edge.to,
            dependsOnLayer: targetLayer,
            rule: `${rule.from} → ${targetLayer}`,
            severity: rule.from === 'domain' ? 'high' : targetLayer === 'api' ? 'high' : 'medium',
          });
        }
      }
    }
  }

  // Sort by severity
  const severityOrder = { high: 0, medium: 1, low: 2 };
  violations.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  // Group by rule for summary
  const byRule = new Map<string, number>();
  for (const v of violations) {
    byRule.set(v.rule, (byRule.get(v.rule) ?? 0) + 1);
  }

  return {
    violations,
    totalViolations: violations.length,
    clean: violations.length === 0,
    summary: [...byRule.entries()].map(([rule, count]) => ({ rule, count })),
    rulesChecked: rules.length,
    confidence: roundConfidence(indexConfidence),
    confidenceNotes: [
      ...confidenceNotes,
      'Layer detection is heuristic based on file path keywords (controller, service, repository, etc.)',
    ],
  };
}
