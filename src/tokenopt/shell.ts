import path from "node:path";

export function quoteShellArg(value: string): string {
  if (process.platform === "win32") {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildNodeCommand(scriptPath: string, args: string[]): string {
  return [quoteShellArg(process.execPath), quoteShellArg(path.resolve(scriptPath)), ...args.map(quoteShellArg)].join(" ");
}

export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(command))) {
    tokens.push((match[1] ?? match[2] ?? match[3] ?? "").replace(/\\"/g, '"'));
  }
  return tokens;
}

export function commandLooksWrapped(command: string): boolean {
  return /\btokenopt(?:\.cmd)?\s+exec\b|\bcli\.js["']?\s+exec\s+--\b/.test(command);
}
