// HTTP/SSE transport — placeholder for v1.1
// stdio is the primary transport for v1.0

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

export async function startHttpTransport(_server: Server, _port: number): Promise<void> {
  throw new Error('HTTP transport is not yet implemented. Use --transport stdio (default).');
}
