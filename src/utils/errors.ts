/**
 * MCP error codes following the JSON-RPC spec + MCP extensions.
 */
export const ErrorCodes = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // Custom MCP errors
  INDEX_NOT_READY: -32001,
  SYMBOL_NOT_FOUND: -32002,
  MODULE_NOT_FOUND: -32003,
  TIMEOUT: -32004,
  PATH_TRAVERSAL: -32005,
} as const;

export class McpToolError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = 'McpToolError';
    this.code = code;
  }
}

export class IndexNotReadyError extends McpToolError {
  constructor() {
    super(ErrorCodes.INDEX_NOT_READY, 'Index is not ready. Building index...');
  }
}

export class SymbolNotFoundError extends McpToolError {
  constructor(symbol: string) {
    super(ErrorCodes.SYMBOL_NOT_FOUND, `Symbol not found: "${symbol}"`);
  }
}

export class ModuleNotFoundError extends McpToolError {
  constructor(module: string) {
    super(ErrorCodes.MODULE_NOT_FOUND, `Module not found: "${module}"`);
  }
}

export class ToolTimeoutError extends McpToolError {
  constructor(toolName: string, timeoutMs: number) {
    super(ErrorCodes.TIMEOUT, `Tool "${toolName}" timed out after ${timeoutMs}ms`);
  }
}
