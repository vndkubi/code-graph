import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = process.cwd();
const CLI = path.resolve("dist/cli.js");

async function listTools(extraArgs = [], extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, "mcp", "--root", ROOT, "--no-prewarm", ...extraArgs],
    env: { ...process.env, ...extraEnv },
  });
  const client = new Client({ name: "fusion-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    return tools.map((t) => t.name);
  } finally {
    await client.close();
  }
}

test("client profile is the single-gate surface: exactly the 3 CodeGraph tools", async () => {
  const names = await listTools([], { TOKENOPT_MCP_MODE: "" });
  assert.deepEqual(names, ["codegraph_context", "codegraph_slice", "codegraph_status"]);
});

test("TOKENOPT_MCP_MODE restores the embedded gate tools on any profile", async () => {
  const names = await listTools([], { TOKENOPT_MCP_MODE: "lite" });
  assert.ok(names.includes("codegraph_context"), "expected codegraph_context");
  assert.ok(names.includes("contextgate_get_context"), "expected contextgate_get_context");
  assert.ok(names.includes("tokenopt_compile_evidence"), "expected tokenopt_compile_evidence");
});

test("full profile widens both surfaces", async () => {
  const names = await listTools(["--mcp-profile", "full"], { TOKENOPT_MCP_MODE: "" });
  // CodeGraph full-profile pack tools
  assert.ok(names.includes("get_research_pack"), "expected get_research_pack in full profile");
  assert.ok(names.includes("review_patch"), "expected review_patch in full profile");
  // TokenOpt full-profile tools
  assert.ok(names.includes("tokenopt_symbols_find"), "expected tokenopt_symbols_find in full profile");
  assert.ok(names.includes("tokenopt_session_stats"), "expected tokenopt_session_stats in full profile");
});

test("TOKENOPT_MCP_MODE=off hides the embedded gate tools even on full profile", async () => {
  const names = await listTools(["--mcp-profile", "full"], { TOKENOPT_MCP_MODE: "off" });
  assert.ok(names.includes("get_research_pack"), "expected get_research_pack in full profile");
  assert.ok(!names.some((name) => name.startsWith("tokenopt_") || name.startsWith("contextgate_")), "expected no tokenopt/contextgate tools with TOKENOPT_MCP_MODE=off");
});
