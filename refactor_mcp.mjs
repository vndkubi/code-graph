import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const filePath = path.join(__dirname, 'src/tokenopt/mcp.ts');
let content = fs.readFileSync(filePath, 'utf8');

console.log('Refactoring mcp.ts...');

// Find the start and end of each legacy tool definition block
const toolsToRemove = [
  'tokenopt_run_command',
  'tokenopt_project_facts', 
  'tokenopt_prepare_java_diff',
  'tokenopt_jakarta_annotation_filter',
  'tokenopt_assemble_spring_context',
  'tokenopt_business_contract',
  'tokenopt_impact_analysis',
  'tokenopt_symbols_find',
  'tokenopt_symbol_packet',
  'tokenopt_test_neighbors',
  'tokenopt_failure_packet',
  'tokenopt_tracebug_packet',
  'tokenopt_session_stats'
];

// Remove each tool definition - match pattern: {\n        name: "tool_name", ... }\nfor (const toolName of toolsToRemove) {
  const pattern = new RegExp(`,\\s*\\{\\s*name:\\s*"${toolName}",[\\s\\S]*?annotations:\\s*\\{[^}]*\\}\\s*\\}`, 'g');
  const matches = content.match(pattern);
  if (matches) {
    console.log(`Removing ${toolName} (${matches.length} occurrence(s))`);
    content = content.replace(pattern, '');
  }
}

// Also remove handler cases in dispatchTokenoptTool function
for (const toolName of toolsToRemove) {
  const handlerPattern = new RegExp(`case\\s+"${toolName}":[\\s\\S]*?(?=\\s*case\\s+"|\\s*default:|\\s*\\})`, 'g');
  const matches = content.match(handlerPattern);
  if (matches) {
    console.log(`Removing handler for ${toolName}`);
    content = content.replace(handlerPattern, '');
  }
}

// Remove unused imports related to legacy tools
const unusedImports = [
  'assembleSpringContext',
  'compileCodingCoverageEvidence',
  'parseFailurePacket',
  'buildSymbolPacket',
  'collectCodingFiles',
  'findCodingSymbols',
  'findTestNeighbors',
  'filterJakartaAnnotations',
  'linkBusinessContracts',
  'analyzeImpact',
  'prepareJavaDiff'
];

for (const imp of unusedImports) {
  const importPattern = new RegExp(`import\\s+\\{[^}]*${imp}[^}]*\\}\\s+from\\s+\"[^\"]+\";?\\s*`, 'g');
  if (content.match(importPattern)) {
    console.log(`Removing import for ${imp}`);
    content = content.replace(importPattern, '');
  }
}

fs.writeFileSync(filePath, content);
console.log('Done! File size:', fs.statSync(filePath).size, 'bytes');
