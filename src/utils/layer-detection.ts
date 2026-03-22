/**
 * Heuristic layer detection based on file path keywords.
 * Shared across graph-builder (index time) and review tools (analysis time).
 */
export function detectLayer(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.includes('controller') || lower.includes('resource') || lower.includes('route')) return 'api';
  if (lower.includes('service') || lower.includes('usecase')) return 'service';
  if (lower.includes('repository') || lower.includes('dao')) return 'repository';
  if (lower.includes('model') || lower.includes('entity') || lower.includes('domain')) return 'domain';
  if (lower.includes('dto') || lower.includes('schema') || lower.includes('request') || lower.includes('response')) return 'dto';
  if (lower.includes('util') || lower.includes('helper') || lower.includes('common')) return 'utility';
  if (lower.includes('config') || lower.includes('setting')) return 'config';
  if (lower.includes('test') || lower.includes('spec')) return 'test';
  return 'other';
}
