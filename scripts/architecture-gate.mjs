#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const violations = [];

function filesUnder(relativeDir) {
  const directory = path.join(root, relativeDir);
  if (!fs.existsSync(directory)) return [];
  const result = [];
  const visit = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (/\.(?:ts|tsx|mjs|js)$/.test(entry.name)) result.push(absolute);
    }
  };
  visit(directory);
  return result;
}

function relative(absolute) {
  return path.relative(root, absolute).replaceAll(path.sep, '/');
}

for (const directory of ['src/v2/mcp', 'src/v2/query', 'src/v2/application']) {
  for (const file of filesUnder(directory)) {
    const text = fs.readFileSync(file, 'utf8');
    if (/\b(?:execFileSync|spawnSync)\b/.test(text)) {
      violations.push(`${relative(file)} uses synchronous child-process execution in the request path`);
    }
  }
}

for (const directory of ['src/v2/query', 'src/v2/application', 'src/v2/infrastructure']) {
  for (const file of filesUnder(directory)) {
    const text = fs.readFileSync(file, 'utf8');
    if (/from\s+['"][^'"]*\/mcp(?:\/|\.js|['"])/.test(text)) {
      violations.push(`${relative(file)} imports an MCP interface from a lower application/domain layer`);
    }
  }
}

// New orchestration/infrastructure modules must remain small enough to review
// in one pass. Existing legacy god objects are intentionally not grandfathered
// into this budget by pretending they are already refactored.
for (const directory of ['src/v2/application', 'src/v2/infrastructure']) {
  for (const file of filesUnder(directory)) {
    const lineCount = fs.readFileSync(file, 'utf8').split(/\r?\n/).length;
    if (lineCount > 1_200) violations.push(`${relative(file)} is ${lineCount} lines (budget 1200)`);
  }
}

if (violations.length > 0) {
  console.error(JSON.stringify({ ok: false, violations }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ ok: true, checks: [
    'no synchronous process execution under MCP/query request paths',
    'no lower-layer import of MCP interfaces',
    'application/infrastructure file-size budget <= 1200 lines',
  ] }, null, 2));
}
