import { z } from 'zod';
import type { FileIndexer } from '../index/file-indexer.js';

export const GetImpactRadiusSchema = z.object({
  target: z.string().describe('Module ID, class name, or file path.'),
  changeType: z.enum(['signature', 'behavior', 'delete', 'any']).default('any').describe('Type of change being made.'),
});

export type GetImpactRadiusInput = z.infer<typeof GetImpactRadiusSchema>;

export async function getImpactRadius(input: GetImpactRadiusInput, indexer: FileIndexer) {
  await indexer.ensureIndexed();

  const graph = indexer.getDependencyGraph();
  const callGraph = indexer.getCallGraph();
  const node = graph.findNode(input.target);
  const nodeId = node?.id ?? input.target;

  // Direct dependents
  const directEdges = graph.getDependents(nodeId);
  const direct = directEdges.map(edge => {
    const depNode = graph.getNode(edge.from);
    const impactType = getImpactType(input.changeType, edge.weight);

    // Find key call sites from call graph
    const callSites: string[] = [];
    const callers = callGraph.getCallers(input.target);
    for (const caller of callers) {
      if (caller.file === edge.from || caller.from.includes(edge.from.split('/').pop() ?? '')) {
        callSites.push(`${caller.from} at ${caller.file}:${caller.line}`);
      }
    }

    return {
      moduleId: edge.from,
      impactType,
      reason: getImpactReason(input.changeType, impactType, edge.from),
      keyCallSites: callSites.slice(0, 5),
    };
  });

  // Transitive dependents
  const transitive = graph.getTransitiveDependents(nodeId, 5).map(t => ({
    moduleId: t.nodeId,
    via: t.via,
    depth: t.depth,
    impactType: 'possible' as const,
  }));

  const hasBreaking = direct.some(d => d.impactType === 'breaking');
  const blastRadius = getBlastRadius(direct.length, transitive.length, hasBreaking);

  const breakingCount = direct.filter(d => d.impactType === 'breaking').length;
  const summary = `${direct.length} direct dependents (${breakingCount} breaking), ${transitive.length} transitive`;

  const recommendations = generateRecommendations(input, direct, transitive);

  // Confidence: penalise parse errors + import gaps + unresolved target
  const state = indexer.getState();
  const notes: string[] = [];
  let confidence = 1.0;
  if (state.filesIndexed > 0 && state.parseErrorCount > 0) {
    const rate = state.parseErrorCount / state.filesIndexed;
    confidence -= rate * 0.3;
    notes.push(`${state.parseErrorCount} file(s) had parse errors — some dependents may be missing`);
  }
  const unresolved = 1 - state.importResolutionRate;
  if (unresolved > 0.05) {
    confidence -= unresolved * 0.2;
    notes.push(`${(unresolved * 100).toFixed(0)}% of imports unresolved — blast radius may be underestimated`);
  }
  if (!node) {
    confidence -= 0.2;
    notes.push(`Target "${input.target}" not found as an exact module — results are best-effort`);
  }

  return {
    target: nodeId,
    blastRadius,
    direct,
    transitive,
    summary,
    recommendations,
    confidence: Math.round(Math.max(0.1, Math.min(1.0, confidence)) * 100) / 100,
    confidenceNotes: notes,
  };
}

function getImpactType(
  changeType: string,
  weight: number,
): 'breaking' | 'likely' | 'possible' {
  if (changeType === 'delete' || changeType === 'signature') return 'breaking';
  if (changeType === 'behavior' && weight > 3) return 'likely';
  if (changeType === 'behavior') return 'possible';
  return weight > 3 ? 'likely' : 'possible';
}

function getImpactReason(changeType: string, impactType: string, moduleId: string): string {
  if (impactType === 'breaking') {
    if (changeType === 'delete') return `${moduleId} directly imports this module — deletion will cause compile errors`;
    if (changeType === 'signature') return `${moduleId} calls methods on this module — signature change will break callers`;
  }
  if (impactType === 'likely') return `${moduleId} heavily uses this module — behavior change may affect logic`;
  return `${moduleId} uses this module — verify correctness after change`;
}

function getBlastRadius(directCount: number, transitiveCount: number, hasBreaking: boolean): 'high' | 'medium' | 'low' {
  if (directCount >= 5 || hasBreaking) return 'high';
  if (directCount >= 2 || transitiveCount > 10) return 'medium';
  return 'low';
}

function generateRecommendations(
  input: GetImpactRadiusInput,
  direct: Array<{ moduleId: string; impactType: string }>,
  transitive: Array<{ moduleId: string }>,
): string[] {
  const recs: string[] = [];
  const breakingModules = direct.filter(d => d.impactType === 'breaking').map(d => d.moduleId);

  if (breakingModules.length > 0) {
    recs.push(`Update callers in: ${breakingModules.join(', ')}`);
  }
  if (input.changeType === 'signature') {
    recs.push('Consider adding a deprecated overload to maintain backward compatibility');
  }
  if (transitive.length > 10) {
    recs.push('High transitive impact — consider feature flag or phased rollout');
  }
  if (direct.length > 0) {
    recs.push(`Run tests for affected modules: ${direct.map(d => d.moduleId).join(', ')}`);
  }

  return recs;
}
