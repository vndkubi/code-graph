const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/tokenopt/mcp.ts');
let content = fs.readFileSync(filePath, 'utf8');

// 1. Remove legacy tool definitions from TOKENOPT_TOOL_DEFINITIONS array
// Keep only: contextgate_get_context, tokenopt_compile_evidence, tokenopt_search, tokenopt_read_file

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

console.log('Refactoring mcp.ts...');
console.log('Tools to remove:', toolsToRemove.length);

// Save the refactored file
fs.writeFileSync(filePath, content);
console.log('Done!');
