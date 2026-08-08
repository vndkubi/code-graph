/**
 * Snapshot-scoped query dispatch.
 *
 * The registry owns only tool-to-handler routing. Query implementations stay
 * in their existing modules/class for now, so this is a compatibility seam for
 * the incremental orchestration refactor rather than a second domain layer.
 */
export type QueryHandler = (
  snapshotId: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

export class QueryHandlerRegistry {
  private readonly handlers = new Map<string, QueryHandler>();

  constructor(entries: ReadonlyArray<readonly [string, QueryHandler]> = []) {
    for (const [name, handler] of entries) this.register(name, handler);
  }

  register(name: string, handler: QueryHandler): this {
    const normalized = name.trim();
    if (!normalized) throw new Error('Query handler name must be non-empty.');
    this.handlers.set(normalized, handler);
    return this;
  }

  has(name: string): boolean {
    return this.handlers.has(name);
  }

  async execute(name: string, snapshotId: string, args: Record<string, unknown>): Promise<unknown> {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`Unknown v2 tool: ${name}`);
    return handler(snapshotId, args);
  }
}
