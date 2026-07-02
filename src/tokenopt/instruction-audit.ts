import fs from "node:fs";
import path from "node:path";
import { estimateTokens } from "./log-compressor.js";

export type InstructionTarget = "agents" | "codex" | "copilot" | "copilot-path" | "copilot-agent" | "generic";

interface AuditFile {
  path: string;
  bytes: number;
  estimatedTokens: number;
  duplicateLines: number;
  conflicts: string[];
}

export interface InstructionGraphFile {
  path: string;
  content: string;
  estimatedTokens: number;
}

export interface InstructionGraphPlan {
  files: InstructionGraphFile[];
  totalEstimatedTokens: number;
  warnings: string[];
}

export interface NativePromptPackPlan {
  files: InstructionGraphFile[];
  totalEstimatedTokens: number;
}

export function auditInstructions(repoRoot: string): string {
  const files = findInstructionFiles(repoRoot);
  if (files.length === 0) {
    return "TokenOpt instruction audit\n\nNo AGENTS.md or GitHub Copilot instruction files found.";
  }

  const audits = files.map((file) => auditFile(file));
  const totalTokens = audits.reduce((sum, item) => sum + item.estimatedTokens, 0);
  const lines = [
    "TokenOpt instruction audit",
    "",
    `files: ${audits.length}`,
    `estimatedTokens: ${totalTokens}`,
    "",
    ...audits.flatMap((audit) => formatAudit(audit, repoRoot))
  ];
  return lines.join("\n").trimEnd();
}

export function emitTokenOptInstructions(target: InstructionTarget = "generic"): string {
  if (target === "copilot-path") {
    return [
      "---",
      "applyTo: \"**\"",
      "---",
      "",
      emitTokenOptInstructions("copilot")
    ].join("\n");
  }
  if (target === "copilot-agent") {
    return [
      "---",
      "name: contextgate-cost-gate",
      "description: Use for broad repository handoff, business/domain research, PBI planning, implementation planning, review coverage, and unit-test planning tasks where a bounded context broker can replace broad exploration.",
      "tools: [\"tokenopt/contextgate_get_context\", \"tokenopt/tokenopt_compile_evidence\", \"tokenopt/tokenopt_search\", \"tokenopt/tokenopt_read_file\", \"codegraph/codegraph_context\", \"codegraph/codegraph_slice\", \"codegraph/codegraph_status\", \"search\", \"read\"]",
      "---",
      "",
      "# ContextGate Cost Gate Agent",
      "",
      "Use ContextGate as the primary coverage-contract broker for broad repo tasks. This agent is a routing gateway: it should prefer the broker first when it can replace broad exploration, but hard enforcement belongs to TokenOpt policy gateway hooks.",
      "",
      "Daily prompt bridge:",
      "",
      "```text",
      "- Users may ask normally: \"review this PR\", \"investigate this PBI\", \"plan this feature\", or \"write tests for this behavior\". Do not wait for them to name MCP tools.",
      "- Preserve the user's prompt, slash prompt, custom agent instructions, and repo instructions. These rules only choose the evidence route.",
      "- Broad or unknown-owner research/PBI/plan/implement/test work: call tokenopt/contextgate_get_context with the natural task, inferred task_type, cwd, required_slots, budget_tokens, and quality_rubric.",
      "- If Jira/Confluence/GitHub has already supplied requirement text, pass it to ContextGate as external_artifacts before source exploration.",
      "- Treat tokenopt/tokenopt_compile_evidence, tokenopt/tokenopt_search, and tokenopt/tokenopt_read_file as legacy/debug or explicit packet followups, not broad first tools.",
      "- Concrete diff/PR/branch/changed-file review: use tokenopt/tokenopt_compile_evidence with task_type=review_diff when it can replace broad source exploration; then only exact followups for changed symbols, similar logic, tests, or requirement evidence.",
      "- Exact file, symbol, endpoint, failing test, stack frame, or line-level trace: use narrow source/graph evidence directly; optionally use the broker only as a coverage checklist after the exact anchor is known.",
      "- If CodeGraph tools are visible, use codegraph/codegraph_context for compact source graph evidence and codegraph/codegraph_slice only for exact slices named by the context packet or current missing slot.",
      "- If the required artifact is missing, ask for it instead of inspecting the repo.",
      "```",
      "",
      "Natural prompts where a broker is usually useful:",
      "",
      "```text",
      "- Study or summarize a business/domain area from repo evidence",
      "- Prepare build, onboarding, or daily handoff",
      "- Plan implementation before editing",
      "- Plan unit tests before writing them",
      "- Investigate a PBI or requirement with Given/When/Then/How/Why acceptance detail",
      "- Review a concrete PR/diff against Jira, Confluence, or attachment requirements",
      "- Investigate a broad failure surface before choosing exact files",
      "```",
      "",
      "Native Copilot prompt files may also be installed under `.github/prompts`: `/investigate-flow`, `/flow-trace`, `/e2e-trace-flow`, `/trace-bug`, `/bug-trace`, `/write-unittest`, `/write-unittest-class`, `/investigate-pbi`, `/implement-feature`, `/pbi-plan`, `/requirement-analysis`, `/security-audit`, `/review-code`, `/performance-analysis`, `/dependency-analysis`, `/refactor-code`, `/spec-feature-plan`, and more.",
      "",
      "Workflow:",
      "",
      "```text",
      "1. Classify the prompt by evidence need: broad/unknown-owner, exact file/symbol/flow, concrete diff/PR, or missing artifact.",
      "2. When broad repo/business/PBI/planning evidence can replace exploration, call contextgate_get_context with the natural task, inferred task_type, cwd, required_slots, budget_tokens around 1200, and a concrete quality_rubric.",
      "3. If answerable=true, answer from the packet with zero redundant search/read.",
      "4. If answerable=false, use only named exact followups for the weakest missing slot.",
      "5. If the task already names the source location, exact symbol, failing test, or diff, use narrow code/review evidence first.",
      "```"
    ].join("\n");
  }
  const heading =
    target === "copilot"
      ? "# ContextGate MCP Usage"
      : "## ContextGate MCP Usage";
  return [
    heading,
    "",
    "When the TokenOpt MCP server is available, treat ContextGate as an evidence broker, not a mandatory extra step before normal tools.",
    "",
    "Daily prompt bridge for Copilot and other agents:",
    "",
    "```text",
    "- The user prompt should stay natural. Do not require phrases such as \"use TokenOpt\", \"use CodeGraph\", or \"call MCP\".",
    "- Keep existing user, slash-prompt, custom-agent, and repo instructions authoritative. This block only chooses the evidence acquisition route.",
    "- Broad/unknown-owner research, PBI investigation, planning, implementation handoff, and unit-test planning: call contextgate_get_context when it can replace broad exploration.",
    "- Concrete code review with diff/PR/branch/changed files: use tokenopt_compile_evidence with task_type=review_diff when a review packet can cover changed files, symbols, similar logic, tests, and requirement evidence cheaper than broad reads.",
    "- If CodeGraph MCP is also configured, use codegraph_context for compact graph/source evidence and codegraph_slice only for exact missing slices. Do not call both TokenOpt and CodeGraph for the same slot when the first packet is sufficient.",
    "- Exact file/symbol/endpoint/failing-test/line-level tasks: start with narrow source or graph evidence, not a broad broker.",
    "- Missing artifact: ask for the missing PBI, requirement, diff, review target, class/module/behavior, failure output, or reproduction steps before repo exploration.",
    "```",
    "",
    "Consider ContextGate/TokenOpt only when it can replace broad exploration or provide a missing evidence-slot checklist:",
    "",
    "```text",
    "- Build/daily/onboarding handoff",
    "- Repo overview or project facts",
    "- Business/product/domain summary from docs/inventory",
    "- PBI/requirement investigation and planning when ownership is unknown",
    "- Implementation planning before editing",
    "- Unit-test planning before writing tests",
    "- Code review business/test coverage when a concrete diff/PR/review target exists",
    "```",
    "",
    "If `.github/prompts` is installed, users may call native Copilot prompt files such as `/investigate-flow`, `/flow-trace`, `/e2e-trace-flow`, `/trace-bug`, `/bug-trace`, `/write-unittest`, `/write-unittest-class`, `/investigate-pbi`, `/implement-feature`, `/pbi-plan`, `/requirement-analysis`, `/security-audit`, `/review-code`, `/performance-analysis`, `/dependency-analysis`, `/refactor-code`, `/spec-feature-plan`, or `/promote-review-memory`. Treat those prompt files as normal user intent plus the routing rules in this instruction file.",
    "",
    "Quality-first routing guardrails:",
    "",
    "```text",
    "- Missing artifact: if PBI/requirement/unit-test/review-memory/review prompts lack the concrete artifact, ask for it and do not inspect the repo.",
    "- Security audit: require concrete diff/scope and security coverage before findings; use exact followups only.",
    "- Coding coverage: for implement/write_unittest/fix/debug, require concrete target symbol/file/behavior/failure; cap write_unittest followups to one.",
    "- Review: diff-first and scope-first; use Jira/Confluence/attachment evidence for business coverage when available, but never as a replacement for the code artifact.",
    "```",
    "",
    "Do not use TokenOpt first when it would create MCP+shell double-spend:",
    "",
    "```text",
    "- Exact existing-flow tracing that needs line-level code proof",
    "- Specific class/method/PBI deep dive where shell/search reads are still required",
    "- Review tasks without a concrete diff or patch for TokenOpt to inspect",
    "```",
    "",
    "For those exact-code tasks, either use normal narrow shell/search/read directly, or run a strict MCP-only session where shell is disabled. Do not call TokenOpt first and then repeat the same acquisition with shell.",
    "",
    "Broker call shape when the broker is the cheapest route:",
    "",
    "```text",
    "When the task needs broad repo evidence, call contextgate_get_context with:",
    "- task: the user's task",
    "- task_type: one of build_handoff, investigate, research_business, implement, write_unittest, api_flow, field_impact, review_diff, startup_flow, unknown",
    "- required_slots: evidence slots the answer must cover, such as source_files, symbols, tests, risks, backend_entrypoint, frontend_state",
    "- cwd: the current repository root",
    "- budget_tokens: 1200-2000",
    "- quality_rubric: 3-6 concrete checks the final answer must satisfy",
    "```",
    "",
    "After the evidence packet:",
    "",
    "```text",
    "If answerable=true and recommended_next_action=answer_now:",
    "- Answer from the packet.",
    "- Cite evidence IDs, files, facts, and missing=[] from the packet.",
    "- Do not call shell, grep, search, read_file, project_facts, run_command, or more MCP tools just to verify the same evidence.",
    "",
    "If missing is non-empty:",
    "- Use only allowed_followups from the packet.",
    "- Keep followups exact and bounded.",
    "- Do not run repo-wide rg --files, broad grep/search, full-file reads, or full-suite tests unless the packet explicitly allows it.",
    "```",
    "",
    "Tool policy:",
    "",
    "```text",
    "Prefer contextgate_get_context over broad raw shell exploration only when it replaces that exploration.",
    "Use tokenopt_search only for exact patterns and narrow paths.",
    "Use tokenopt_read_file only for bounded slices around exact matches.",
    "Default lite mode exposes contextgate_get_context plus legacy compile_evidence, search, and read_file to reduce MCP schema/context overhead.",
    "Use tokenopt_run_command for builds/tests only when that tool is visible/full mode is explicitly enabled.",
    "Do not bypass TokenOpt with shell fallback after an answerable packet.",
    "Do not do MCP-first plus shell fallback for exact code-flow/class/PBI tasks; that is expected to increase input tokens.",
    "```",
    "",
    "Daily task mapping:",
    "",
    "```text",
    "Build or onboarding handoff -> task_type=build_handoff",
    "Debugging, triage, why something fails -> task_type=investigate",
    "Business/product/domain research or deep dive -> task_type=research_business",
    "Implementation planning or small code change -> task_type=implement",
    "Unit-test planning or test-writing task -> task_type=write_unittest",
    "Existing business/API/user flow, flowchart, sequence diagram, or Mermaid request -> task_type=api_flow",
    "Field/schema impact -> task_type=field_impact",
    "Diff or PR review -> task_type=review_diff",
    "Startup/bootstrap flow -> task_type=startup_flow",
    "```",
    "",
    "Final answer requirements:",
    "",
    "```text",
    "Use concise headings.",
    "Include what is known, evidence used, missing items if any, and exact next steps.",
    "Mention when TokenOpt marked the task answerable.",
    "Avoid saying more exploration is needed when missing=[] and answerable=true.",
    "```"
  ].join("\n");
}

export function installTokenOptInstructions(repoRoot: string, target: Exclude<InstructionTarget, "generic">): string {
  const filePath = instructionTargetPath(repoRoot, target);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const snippet = emitTokenOptInstructions(target);
  if (target === "copilot-path" || target === "copilot-agent") {
    fs.writeFileSync(filePath, `${snippet.trimEnd()}\n`, "utf8");
    return filePath;
  }
  const markerStart = "<!-- tokenopt:mcp-instructions:start -->";
  const markerEnd = "<!-- tokenopt:mcp-instructions:end -->";
  const block = `${markerStart}\n${snippet}\n${markerEnd}`;
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const next = existing.includes(markerStart) && existing.includes(markerEnd)
    ? existing.replace(new RegExp(`${escapeRegExp(markerStart)}[\\s\\S]*?${escapeRegExp(markerEnd)}`), block)
    : `${existing.trimEnd()}${existing.trim().length > 0 ? "\n\n" : ""}${block}\n`;
  fs.writeFileSync(filePath, next, "utf8");
  return filePath;
}

export function buildInstructionGraph(repoRoot: string): InstructionGraphPlan {
  const files: InstructionGraphFile[] = [
    graphFile(path.join(repoRoot, ".github", "copilot-instructions.md"), rootInstructionGraphContent()),
    graphFile(path.join(repoRoot, ".github", "instructions", "tokenopt-review.instructions.md"), reviewInstructionGraphContent()),
    graphFile(path.join(repoRoot, ".github", "instructions", "tokenopt-runtime.instructions.md"), runtimeInstructionGraphContent()),
    graphFile(path.join(repoRoot, "AGENTS.md"), agentsInstructionGraphContent())
  ];
  const totalEstimatedTokens = files.reduce((sum, file) => sum + file.estimatedTokens, 0);
  const warnings = [
    totalEstimatedTokens > 2000 ? `Instruction graph is ${totalEstimatedTokens} estimated tokens; keep root instructions short and path-specific guidance scoped.` : undefined,
    ...files.flatMap((file) => file.estimatedTokens > 900 ? [`${path.relative(repoRoot, file.path)} is ${file.estimatedTokens} estimated tokens; consider shortening.`] : [])
  ].filter((warning): warning is string => Boolean(warning));
  return { files, totalEstimatedTokens, warnings };
}

export function formatInstructionGraphPlan(repoRoot: string, plan = buildInstructionGraph(repoRoot)): string {
  return [
    "TokenOpt instruction graph plan",
    `repo: ${repoRoot}`,
    `files: ${plan.files.length}`,
    `estimatedTokens: ${plan.totalEstimatedTokens}`,
    "",
    "Files:",
    ...plan.files.map((file) => `- ${path.relative(repoRoot, file.path)} (${file.estimatedTokens} est tokens)`),
    "",
    "Warnings:",
    ...(plan.warnings.length > 0 ? plan.warnings.map((warning) => `- ${warning}`) : ["- none"])
  ].join("\n");
}

export function buildNativePromptPack(repoRoot: string): NativePromptPackPlan {
  const files = TOKENOPT_NATIVE_PROMPTS.map((prompt) =>
    graphFile(path.join(repoRoot, ".github", "prompts", prompt.fileName), formatNativePromptFile(prompt))
  );
  return {
    files,
    totalEstimatedTokens: files.reduce((sum, file) => sum + file.estimatedTokens, 0)
  };
}

export function formatNativePromptPackPlan(repoRoot: string, plan = buildNativePromptPack(repoRoot)): string {
  return [
    "TokenOpt native prompt pack plan",
    `repo: ${repoRoot}`,
    `files: ${plan.files.length}`,
    `estimatedTokens: ${plan.totalEstimatedTokens}`,
    "",
    "Files:",
    ...plan.files.map((file) => `- ${path.relative(repoRoot, file.path)} (${file.estimatedTokens} est tokens)`)
  ].join("\n");
}

export function installNativePromptPack(repoRoot: string): string[] {
  const plan = buildNativePromptPack(repoRoot);
  const written: string[] = [];
  for (const file of plan.files) {
    fs.mkdirSync(path.dirname(file.path), { recursive: true });
    fs.writeFileSync(file.path, `${file.content.trimEnd()}\n`, "utf8");
    written.push(file.path);
  }
  return written;
}

export function installInstructionGraph(repoRoot: string): string[] {
  const plan = buildInstructionGraph(repoRoot);
  const written: string[] = [];
  for (const file of plan.files) {
    fs.mkdirSync(path.dirname(file.path), { recursive: true });
    if (path.basename(file.path) === "AGENTS.md" || path.basename(file.path) === "copilot-instructions.md") {
      writeMarkedInstructionBlock(file.path, file.content);
    } else {
      fs.writeFileSync(file.path, `${file.content.trimEnd()}\n`, "utf8");
    }
    written.push(file.path);
  }
  return written;
}

interface NativePromptTemplate {
  fileName: string;
  name: string;
  description: string;
  argumentHint: string;
  body: string[];
}

const TOKENOPT_NATIVE_PROMPTS: NativePromptTemplate[] = [
  {
    fileName: "business-deep-dive.prompt.md",
    name: "business-deep-dive",
    description: "Study a product, business, or domain area from repo evidence.",
    argumentHint: "<business area, domain term, product capability, or repo scope>",
    body: [
      "Study the provided business/domain area from repository evidence. Return JSON.",
      "",
      "TokenOpt routing:",
      "- This is usually a broad repo/domain task, so use TokenOpt as a cost gate when it can replace broad exploration.",
      "- If the requested area is named, require evidence tied to that target before answerable=true.",
      "- If exact line-level flow proof is needed, switch to native narrow search/read for that exact flow.",
      "",
      "JSON keys: status, business_summary, actors, concepts, glossary, flows, evidence_used, gaps, next_steps."
    ]
  },
  {
    fileName: "build-handoff.prompt.md",
    name: "build-handoff",
    description: "Create a build/onboarding/daily handoff grounded in repo facts.",
    argumentHint: "<optional target module or handoff focus>",
    body: [
      "Create a concise build/onboarding/daily handoff grounded in repository evidence. Return JSON.",
      "",
      "TokenOpt routing:",
      "- This is a broad repo handoff task; use tokenopt_compile_evidence once as a cost gate when available.",
      "- If answerable=true, answer from the packet and do not gather redundant repo facts.",
      "- Prefer copied package/build commands over inferred commands.",
      "",
      "JSON keys: status, build_system, package_manager, key_commands, repo_map, fast_validation, risks, evidence_used."
    ]
  },
  {
    fileName: "context-budget.prompt.md",
    name: "context-budget",
    description: "Inspect context budget risks and recommend compaction checkpoints.",
    argumentHint: "<optional workflow, task, or repo area>",
    body: [
      "Inspect context budget risks and recommend compaction/checkpoint strategy. Return JSON.",
      "",
      "TokenOpt routing:",
      "- Use TokenOpt for broad repo shape and cost-risk evidence.",
      "- Do not read large raw files unless a concrete budget driver is named.",
      "- Recommend checkpoints based on evidence, not generic advice.",
      "",
      "JSON keys: status, budget_drivers, risky_workflows, compaction_checkpoints, reuse_candidates, missing_items, evidence_used."
    ]
  },
  {
    fileName: "dependency-analysis.prompt.md",
    name: "dependency-analysis",
    description: "Analyze dependency/build graph risks and targeted verification.",
    argumentHint: "<dependency, package, module, conflict, or build symptom>",
    body: [
      "Analyze dependency/build risks and propose targeted verification. Return JSON.",
      "",
      "TokenOpt routing:",
      "- Use TokenOpt for broad build facts and dependency context when the target is not exact.",
      "- If a concrete dependency/config/file is named, use native narrow search/read around that artifact.",
      "- Avoid lockfile reads unless they are necessary for the stated dependency question.",
      "",
      "JSON keys: status, dependency_scope, build_files, risks, verification_commands, missing_items, evidence_used."
    ]
  },
  {
    fileName: "field-impact.prompt.md",
    name: "field-impact",
    description: "Analyze impact of changing a field, schema, property, or API contract.",
    argumentHint: "<field/schema/property/API name>",
    body: [
      "Analyze the impact of changing the provided field/schema/property/API contract. Return JSON.",
      "",
      "TokenOpt routing:",
      "- This is an exact impact task; prefer native narrow search/read around the named field or contract.",
      "- Use TokenOpt only for broad business/context summary if needed before exact impact work.",
      "- Cite producers, consumers, validation, persistence, API contracts, tests, and migration risks.",
      "",
      "JSON keys: status, target, producers, consumers, validation, persistence, api_contracts, tests, migration_risks, evidence_used."
    ]
  },
  {
    fileName: "flow-trace.prompt.md",
    name: "flow-trace",
    description: "Trace an exact code/API/business flow with line-level evidence.",
    argumentHint: "<flow name, endpoint, entrypoint, class, or behavior>",
    body: [
      "Trace the provided flow end to end and cite exact evidence. Return JSON unless the user asks for Mermaid.",
      "",
      "TokenOpt routing:",
      "- If the prompt names an entrypoint, endpoint, class, route, or exact behavior, use native narrow search/read directly.",
      "- Do not call ContextGate first for line-level flow proof; it usually double-spends.",
      "- If the owner is unknown and the task is broad flow discovery, use TokenOpt once, then exact followups only.",
      "",
      "JSON keys: status, acquisition_path, entrypoints, ordered_steps, files_and_symbols, unknown_edges, tests, evidence_used."
    ]
  },
  {
    fileName: "investigate-flow.prompt.md",
    name: "investigate-flow",
    description: "Investigate an unknown or partially-known product/code flow with bounded evidence.",
    argumentHint: "<flow, symptom, endpoint, class, behavior, or business area>",
    body: [
      "Investigate the provided flow or behavior and produce an evidence-backed handoff. Return compact JSON.",
      "",
      "TokenOpt/CodeGraph routing:",
      "- If CodeGraph MCP is available and indexed, use CodeGraph as the source-of-truth for files, symbols, tests, and flow edges.",
      "- If TokenOpt MCP is available, use it as the slot checklist for summary, invariants, risks, tests, and missing coverage.",
      "- TokenOpt-only mode: call TokenOpt once, then only exact allowed followups for missing named slots.",
      "- CodeGraph-only mode: use one flow/research/change pack first; do not fall back to broad shell reads.",
      "- TokenOpt+CodeGraph mode: TokenOpt defines required slots, CodeGraph fills source evidence; stop when slots are complete.",
      "- If neither MCP can name exact evidence, use one exact anchor search and one bounded slice read, then mark gaps.",
      "",
      "JSON keys: status, acquisition_path, summary, flow, invariants, files, symbols, tests_to_run, risks, missing_coverage."
    ]
  },
  {
    fileName: "e2e-trace-flow.prompt.md",
    name: "e2e-trace-flow",
    description: "Trace an end-to-end user/API flow with ordered evidence and tests.",
    argumentHint: "<endpoint, UI action, job, message, class, or behavior>",
    body: [
      "Trace the provided end-to-end flow from entrypoint through domain/storage/dependencies to tests. Return compact JSON unless the user asks for Mermaid.",
      "",
      "TokenOpt/CodeGraph routing:",
      "- Prefer CodeGraph flow evidence when the target names an endpoint, UI action, job, message, class, or behavior.",
      "- Use TokenOpt only as a completeness checklist for business invariants, tests, risks, and unresolved edges.",
      "- Do not run repo-wide exploration. Use exact followups only for one missing edge at a time.",
      "- Mark inferred edges explicitly; do not present candidate files as confirmed flow proof.",
      "",
      "JSON keys: status, acquisition_path, entrypoint, sequence, invariants, files, symbols, tests_to_run, inferred_edges, risks."
    ]
  },
  {
    fileName: "implement-feature.prompt.md",
    name: "implement-feature",
    description: "Implement or plan a concrete feature with targeted validation.",
    argumentHint: "<feature/PBI/spec text and optional target module>",
    body: [
      "Implement or plan the provided feature using the smallest safe change. Return JSON if planning; edit files only if explicitly asked.",
      "",
      "Natural evidence routing:",
      "- If the owning file/module/symbol is known, start with narrow source/test evidence and targeted validation.",
      "- If ownership is unknown or the PBI/spec is broad, use a compact context broker or CodeGraph change evidence to identify owner files, symbols, existing tests, business rules, and validation commands before editing.",
      "- Require business behavior coverage, not only method coverage: acceptance criteria, user value, compatibility constraints, negative cases, and regression tests.",
      "- Do not treat implementation evidence as complete without owner source, relevant symbols, test neighbor/style, and a build/test command.",
      "",
      "JSON keys: status, scope, target_files, implementation_steps, business_coverage, tests, validation, risks, missing_items."
    ]
  },
  {
    fileName: "onboarding-guide.prompt.md",
    name: "onboarding-guide",
    description: "Create a concise onboarding guide grounded in repo evidence.",
    argumentHint: "<optional audience or module>",
    body: [
      "Create a concise onboarding guide grounded in repository evidence. Return JSON sections and citations.",
      "",
      "TokenOpt routing:",
      "- This is a broad repo task; use TokenOpt as a cost gate for build facts, repo shape, docs, and quick validation.",
      "- Do not inspect exact source files unless the onboarding target names a specific module.",
      "- Prefer verified setup and test commands from repo files.",
      "",
      "JSON keys: status, audience, setup, repo_map, common_workflows, verification, risks, evidence_used."
    ]
  },
  {
    fileName: "pbi-plan.prompt.md",
    name: "pbi-plan",
    description: "Create a compatibility-preserving implementation plan from a concrete PBI or requirement.",
    argumentHint: "<paste PBI/requirement text, ticket URL, or acceptance criteria>",
    body: [
      "Create an implementation plan for the provided PBI/requirement while preserving compatibility. Return JSON.",
      "",
      "Natural evidence routing:",
      "- If no concrete PBI, requirement body, issue URL, or acceptance criteria is provided, do not explore the repo. Ask for the missing artifact in JSON.",
      "- If the PBI has Given/When/Then, How, Why, acceptance criteria, or direct attachment text, treat that as the business artifact and map it to repo evidence.",
      "- Use a context broker when the owner is unknown; use exact source/graph evidence when the prompt names a file, symbol, endpoint, field, or diff.",
      "- Plan business behavior coverage and validation before edits: acceptance paths, negative paths, compatibility, and regression tests.",
      "- Keep followups exact and bounded to the weakest missing slot.",
      "",
      "JSON keys: status, requirement_summary, given_when_then, how, why, impacted_areas, implementation_plan, tests, compatibility_risks, missing_items, next_steps."
    ]
  },
  {
    fileName: "investigate-pbi.prompt.md",
    name: "investigate-pbi",
    description: "Investigate a concrete PBI before planning or editing.",
    argumentHint: "<PBI text, ticket URL, or acceptance criteria>",
    body: [
      "Investigate the provided PBI before planning edits. Return compact JSON.",
      "",
      "Natural evidence routing:",
      "- If no PBI, requirement body, ticket URL, or acceptance criteria is provided, ask for the artifact and do not inspect the repo.",
      "- Treat pasted Given/When/Then, How, Why, acceptance criteria, Jira text, Confluence text, or direct attachment summaries as valid requirement evidence.",
      "- Extract business slots first: user value, Given/When/Then, How, Why, acceptance criteria, compatibility constraints, unknowns, risks, and validation.",
      "- Use compact broker or graph/source evidence only for missing repo slots: impacted files, symbols, existing tests, current behavior, and validation commands.",
      "- If a file, symbol, endpoint, field, or diff is named, go exact first instead of broad context.",
      "- Stop when the requested evidence slots are covered; do not duplicate the same evidence through another provider.",
      "",
      "JSON keys: status, pbi_summary, given_when_then, how, why, current_behavior, impacted_files, symbols, tests, unknowns, risks, next_steps."
    ]
  },
  {
    fileName: "performance-analysis.prompt.md",
    name: "performance-analysis",
    description: "Analyze likely performance hotspots with measurement-first optimization guidance.",
    argumentHint: "<hotspot, workflow, query, endpoint, or module>",
    body: [
      "Analyze likely performance hotspots and propose measurement-first optimizations. Return JSON.",
      "",
      "TokenOpt routing:",
      "- If no hotspot/target is named, use TokenOpt for broad repo evidence and clearly mark hypotheses.",
      "- If an endpoint/query/module is named, use native narrow search/read around that exact path.",
      "- Do not propose fixes without measurement and targeted validation.",
      "",
      "JSON keys: status, target, suspected_hotspots, measurements, optimization_options, validation, risks, evidence_used."
    ]
  },
  {
    fileName: "requirement-analysis.prompt.md",
    name: "requirement-analysis",
    description: "Analyze a concrete requirement into WHAT, WHY, HOW, acceptance criteria, tests, and unknowns.",
    argumentHint: "<paste requirement text or ticket URL>",
    body: [
      "Analyze the provided requirement. Return JSON with WHAT, WHY, HOW, acceptance criteria, impacted areas, tests, and unknowns.",
      "",
      "TokenOpt routing:",
      "- If the requirement text or ticket URL is missing, do not inspect the repo. Return bounded JSON asking for the requirement artifact.",
      "- Do not invent repo-specific evidence when the requirement is absent.",
      "- When artifact exists, use TokenOpt only for broad repo evidence that replaces exploration.",
      "",
      "JSON keys: status, what, why, how, acceptance_criteria, impacted_areas, tests, unknowns, evidence_used."
    ]
  },
  {
    fileName: "refactor-scope.prompt.md",
    name: "refactor-scope",
    description: "Scope a refactor/migration with impacted usages, contracts, config, and tests.",
    argumentHint: "<symbol, API, migration, resource, package, or behavior>",
    body: [
      "Scope the provided refactor or migration. Return impacted definitions, usages, contracts, config, tests, and risks as JSON.",
      "",
      "TokenOpt routing:",
      "- If the refactor target is exact, use native narrow search/read for definitions and usages.",
      "- Use TokenOpt for broader impact planning only when it can replace repo-wide exploration.",
      "- Keep output as a plan unless the user explicitly asks for edits.",
      "",
      "JSON keys: status, target, definitions, usages, contracts, config, tests, migration_risks, validation_plan, evidence_used."
    ]
  },
  {
    fileName: "refactor-code.prompt.md",
    name: "refactor-code",
    description: "Plan a behavior-preserving refactor with exact usages, tests, and validation.",
    argumentHint: "<symbol, module, API, migration, resource, or behavior>",
    body: [
      "Plan the provided refactor with behavior invariants first. Return compact JSON unless the user explicitly asks for edits.",
      "",
      "TokenOpt/CodeGraph routing:",
      "- If the target symbol/file/API is exact, use CodeGraph references or native narrow reads for definitions, usages, tests, and contracts.",
      "- Use TokenOpt as the checklist for behavior invariants, compatibility risks, and validation coverage.",
      "- In CodeGraph-only mode, start with get_change_pack or references; do not broaden to repo overview.",
      "- In TokenOpt+CodeGraph mode, combine TokenOpt risk slots with CodeGraph exact impact evidence.",
      "- Do not propose behavior changes unless they are explicitly required.",
      "",
      "JSON keys: status, refactor_goal, current_flow, definitions, usages, files, symbols, safe_steps, tests, validation_commands, risks."
    ]
  },
  {
    fileName: "repo-benchmark-analysis.prompt.md",
    name: "repo-benchmark-analysis",
    description: "Analyze a repository as a benchmark target with cost and task-class risks.",
    argumentHint: "<optional benchmark focus>",
    body: [
      "Analyze this repository as a benchmark target: build facts, repo shape, likely task classes, and cost risks. Return JSON.",
      "",
      "TokenOpt routing:",
      "- This is a broad repo analysis task; use TokenOpt as a cost gate.",
      "- Do not enumerate all files in model context; rely on bounded inventory/facts.",
      "- Identify which task classes should use TokenOpt and which should bypass it.",
      "",
      "JSON keys: status, build_facts, repo_shape, likely_task_classes, cost_risks, benchmark_suggestions, evidence_used."
    ]
  },
  {
    fileName: "write-unittest.prompt.md",
    name: "write-unittest",
    description: "Plan or write focused unit tests for a concrete class/module/behavior.",
    argumentHint: "<target class/module/file and behavior>",
    body: [
      "Plan or write focused unit tests for the provided target and behavior. Return JSON unless the user asks for code edits.",
      "",
      "Natural evidence routing:",
      "- Require a concrete target class, module, file, behavior, or failing case.",
      "- If the target is missing, do not search the repo to guess it. Ask for the target/behavior.",
      "- If the target exists, gather exact owner source, existing tests, fixtures/mocks, style, and validation command before proposing tests.",
      "- Use a broker or graph evidence only when it replaces broad owner/test discovery; otherwise use narrow source/test reads.",
      "- Cover business behavior and acceptance criteria, including boundary, negative/error, state transition, compatibility, and regression cases; do not stop at method coverage.",
      "- Use at most one exact followup for a missing owner/test/fixture slot after the first evidence pass.",
      "",
      "JSON keys: status, target, behavior, test_location, test_cases, fixtures_or_mocks, assertions, targeted_command, missing_items."
    ]
  },
  {
    fileName: "write-unittest-class.prompt.md",
    name: "write-unittest-class",
    description: "Plan or write class-level unit tests for a concrete class/module behavior.",
    argumentHint: "<class/module/file and behavior>",
    body: [
      "Plan or write focused class-level unit tests for the provided target and behavior. Return JSON unless the user asks for code edits.",
      "",
      "Natural evidence routing:",
      "- Require a concrete class, module, file, method, behavior, failing case, or acceptance criterion.",
      "- If the target is missing, ask for target/behavior and do not search the repo to guess it.",
      "- Use exact source/test evidence for the named class; use broker/graph evidence only for missing owner/test/style discovery.",
      "- Include existing test style, fixtures/mocks, assertions, edge cases, and targeted validation command.",
      "- Cover user/business behavior and acceptance criteria, not only public method names.",
      "- Keep followups exact and bounded to the weakest missing source/test slot.",
      "",
      "JSON keys: status, target_class, behavior, existing_coverage, missing_coverage, test_location, test_cases, fixtures_or_mocks, assertions, targeted_command, risks."
    ]
  },
  {
    fileName: "security-audit.prompt.md",
    name: "security-audit",
    description: "Run a security-focused review only when concrete diff/scope is provided.",
    argumentHint: "<diff, PR, changed files, route, symbol, or risky surface>",
    body: [
      "Perform a security-focused review of the provided changed behavior or risky surface. Return JSON findings.",
      "",
      "TokenOpt routing:",
      "- Use security_audit route.",
      "- Require concrete diff/scope before findings.",
      "- Security coverage must consider target/scope, input boundaries, auth/authz, validation/deserialization, secrets/config/dependencies, and tests/guardrails.",
      "- If scope is missing, do not broad-search. Ask for the diff, PR, changed files, route, symbol, or risky surface.",
      "- Use exact followups only; never use broad shell review fallback.",
      "",
      "JSON keys: status, findings, evidence_used, missing_coverage, non_findings, next_steps."
    ]
  },
  {
    fileName: "spec-autorun.prompt.md",
    name: "spec-autorun",
    description: "Plan a SpecKit /autorun workflow with bounded phases and evidence reuse.",
    argumentHint: "<spec, feature, or workflow goal>",
    body: [
      "Plan a SpecKit /autorun workflow with bounded phases, evidence reuse, and verification checkpoints. Return JSON.",
      "",
      "TokenOpt routing:",
      "- Use TokenOpt for broad planning only when it replaces exploration.",
      "- Split the work into bounded phases with clear stop/verify points.",
      "- Reuse evidence packets and avoid repeating the same searches across phases.",
      "",
      "JSON keys: status, phases, evidence_reuse, checkpoints, validation, stop_conditions, risks."
    ]
  },
  {
    fileName: "spec-feature-plan.prompt.md",
    name: "spec-feature-plan",
    description: "Specify or plan a feature from repo/domain evidence with acceptance criteria.",
    argumentHint: "<feature idea, spec text, or acceptance criteria>",
    body: [
      "Specify or plan the provided feature from repo/domain evidence and produce acceptance criteria. Return JSON.",
      "",
      "Natural evidence routing:",
      "- If feature/spec text is missing, ask for it instead of exploring.",
      "- Keep Spec Kit prompts basic. The user does not need to name TokenOpt, CodeGraph, ContextGate, or MCP tools.",
      "- During specify/plan/tasks/implement, decide whether compact repo evidence is useful from the evidence slots: domain context, owner files, impacted symbols, existing tests, validation commands, risks, and unknowns.",
      "- Use a broker for broad/unknown-owner spec work; use exact source/graph evidence when the prompt names a file, symbol, endpoint, field, or diff.",
      "- Reuse evidence across phases instead of re-reading the same files; refill only the weakest missing slot.",
      "- Keep implementation, tests, validation, acceptance criteria, and unknowns explicit.",
      "",
      "JSON keys: status, feature_summary, tokenopt_detection, phases, domain_evidence, acceptance_criteria, implementation_outline, tests, validation, unknowns, evidence_used."
    ]
  },
  {
    fileName: "startup-flow.prompt.md",
    name: "startup-flow",
    description: "Trace application startup/bootstrap flow or debug startup failure.",
    argumentHint: "<application/module, startup failure, stack trace, or config target>",
    body: [
      "Trace startup/bootstrap flow or debug the provided startup failure. Return JSON.",
      "",
      "TokenOpt routing:",
      "- For exact startup flow tracing with known entrypoint/config, use native narrow search/read.",
      "- For long stack traces/build logs, use tokenopt_failure_packet to extract exact files/lines before bounded reads.",
      "- If no startup artifact or target is provided, ask for entrypoint, config, stack trace, or failing command.",
      "",
      "JSON keys: status, acquisition_path, entrypoint, initialization_order, config_loading, failure_points, targeted_verification, evidence_used."
    ]
  },
  {
    fileName: "trace-bug.prompt.md",
    name: "trace-bug",
    description: "Trace an exact bug from concrete failure evidence using native narrow reads by default.",
    argumentHint: "<failing test, stack trace, error output, repro steps, file, class, function, or behavior>",
    body: [
      "Trace the provided bug using exact evidence. Return JSON.",
      "",
      "TokenOpt routing:",
      "- If a file, class, function, line, failing test, stack frame, or exact behavior is provided, use native narrow search/read directly.",
      "- Do not call ContextGate first for exact bug tracing; it usually double-spends.",
      "- If stack trace/build/test output is long, use tokenopt_failure_packet first, then narrow read the suggested slices.",
      "- If no concrete bug artifact is provided, ask for failing test, stack trace/error output, repro steps, expected vs actual behavior, or target symbol.",
      "",
      "JSON keys: status, acquisition_path, bug_summary, evidence_chain, suspected_root_cause, affected_files, targeted_fix_location, verification, missing_items."
    ]
  },
  {
    fileName: "bug-trace.prompt.md",
    name: "bug-trace",
    description: "Trace a concrete bug from failure evidence to likely owner code and validation.",
    argumentHint: "<failing test, stack trace, repro, endpoint, file, class, function, or behavior>",
    body: [
      "Trace the provided bug from concrete evidence to likely root cause and fix handoff. Return compact JSON.",
      "",
      "TokenOpt/CodeGraph routing:",
      "- Start from the failure artifact: failing test, stack frame, error output, repro steps, endpoint, file, class, function, or exact behavior.",
      "- For long logs, use TokenOpt failure compression before any source reads.",
      "- For indexed repos, use CodeGraph flow/change evidence to map the failure to owner symbols and tests.",
      "- Avoid broad repo exploration; use exact followups only for missing owner/test evidence.",
      "- If no concrete bug artifact exists, ask for repro, expected vs actual, failing test, stack trace, or target symbol.",
      "",
      "JSON keys: status, acquisition_path, bug_summary, reproduction_path, evidence_chain, root_cause_hypotheses, affected_files, symbols, fix_plan, tests_to_run, risks."
    ]
  },
  {
    fileName: "review-code.prompt.md",
    name: "review-code",
    description: "Review concrete code diffs with bounded technical findings and business/test coverage gaps.",
    argumentHint: "<diff, PR, changed files, or exact review target>",
    body: [
      "Review the provided code diff/scope in two phases: technical review first, then business/edge-case/test-design coverage review. Return compact JSON.",
      "",
      "Natural evidence routing:",
      "- Diff-first and scope-first.",
      "- The user does not need to name TokenOpt, CodeGraph, ContextGate, or MCP. If setup exposes those tools, choose them from the evidence need.",
      "- With a concrete diff/PR/branch pair/changed-files target, use a review evidence broker such as `tokenopt_compile_evidence` with `task_type=review_diff` when it can replace broad source exploration.",
      "- When CodeGraph tools are available, use compact graph context for changed-code impact and exact graph slices only for missing changed symbols, callers/callees, similar logic, or tests.",
      "- If the input has a concrete diff, PR, branch pair, changed files, file path, symbol, or exact review target, choose the cheapest review-shaped evidence path that covers changed files, changed symbols, similar logic, impacted tests, and business requirements.",
      "- If the input is a PR number or URL, review the net PR diff and use the PR merge/head worktree as cwd before follow-up reads/searches.",
      "- If the input is a branch pair, treat the target branch as base and the feature/source branch as head; review the net merge-base diff, not per-commit patches.",
      "- If a review broker is available, use it when it can replace broad source exploration; otherwise use exact diff, source, and test reads.",
      "- If the user provides Jira tickets or Confluence pages/URLs, use the available Jira/Confluence connectors to read the ticket/page and relevant attachments before the business/test coverage phase. Do not ask the user to paste the full ticket/page content when a connector can read it. Treat them as requirement evidence, not as a replacement for the code review artifact.",
      "- If Jira/Confluence MCP tools are unavailable or the ticket/page cannot be read, state this in `notes` and mark requirement-backed business coverage as missing or assumption-based.",
      "- If no diff, PR, changed files, file path, symbol, or exact target is provided, do not explore the repo. Ask for the review artifact.",
      "- When concrete diff/scope exists, keep followups exact and bounded to changed symbols, callers/callees, similar logic, tests, or requirement evidence.",
      "- Treat domain words like security, auth, privilege, or permission as code-review context unless the user explicitly asks for a security audit/review.",
      "- If the user provides a review checklist, preserve it as required review rubric and answer every checklist item.",
      "",
      "Technical review phase:",
      "- Report only introduced, actionable correctness, security, performance, reliability, compatibility, or maintainability defects.",
      "- If TokenOpt evidence includes recall_probe facts, adjudicate each checked probe as a technical finding, coverage gap, or explicit non-issue with contrary evidence. Promote P1/P2 technical_finding_candidate=true probes unless contrary evidence disproves them.",
      "- Before saying no findings, check changed invariants, effective config/policy math, parser/encoding boundaries, backward compatibility, concurrency/async behavior, resource lifecycle, null/error paths, and call replacements.",
      "- Do not downgrade a proven regression into a test gap.",
      "",
      "Business/test coverage phase:",
      "- Report non-blocking gaps separately from technical findings.",
      "- Ground requirement coverage in Jira/Confluence/direct attachment evidence when the user provided those artifacts; otherwise mark requirement assumptions explicitly.",
      "- Apply ISTQB-style dimensions where relevant: boundary values, equivalence partitions, negative/error cases, state transitions, concurrency/async, and compatibility/backward compatibility.",
      "- Prefer exact tests tied to the changed behavior over broad test requests.",
      "- Avoid style nits unless they affect behavior.",
      "",
      "User checklist phase:",
      "- Return item-by-item checklist coverage as pass, fail, gap, or not_applicable with evidence or a short reason.",
      "- A checklist item becomes a technical finding only when the diff introduces an actionable defect; otherwise keep it in coverage/commentary.",
      "- Checklist scope does not suppress higher-severity defects found outside the checklist.",
      "",
      "JSON keys: technical_review, business_review, attachment_evidence, istqb_checks, user_checklist, review_status, evidence_contract_pass, acquisition_mode, notes."
    ]
  },
  {
    fileName: "promote-review-memory.prompt.md",
    name: "promote-review-memory",
    description: "Extract reusable review-memory candidates from completed task evidence.",
    argumentHint: "<completed task summary, transcript, diff, or review outcome>",
    body: [
      "Identify what should be promoted into review memory after a completed task. Return JSON.",
      "",
      "TokenOpt routing:",
      "- Require completed-task evidence: summary, transcript, diff, review findings, or final outcome.",
      "- If completed-task evidence is missing, do not inspect the repo. Ask for that evidence.",
      "- Promote only stable, reusable facts. Avoid stale branch-specific details.",
      "",
      "JSON keys: status, memory_candidates, expiry_or_refresh, excluded_items, missing_items, rationale."
    ]
  }
];

function formatNativePromptFile(prompt: NativePromptTemplate): string {
  return [
    "---",
    `name: ${prompt.name}`,
    `description: ${JSON.stringify(prompt.description)}`,
    `argument-hint: ${JSON.stringify(prompt.argumentHint)}`,
    "agent: agent",
    "---",
    "",
    ...prompt.body
  ].join("\n");
}

function graphFile(filePath: string, content: string): InstructionGraphFile {
  return {
    path: filePath,
    content,
    estimatedTokens: estimateTokens(content.length)
  };
}

function rootInstructionGraphContent(): string {
  return [
    "# TokenOpt ContextGate",
    "",
    "Use TokenOpt as a selective context governor, not as MCP-first for every prompt.",
    "",
    "Users may use normal Copilot prompts. Do not require them to say TokenOpt, CodeGraph, ContextGate, or MCP.",
    "When TokenOpt tools are visible, map the prompt to evidence slots yourself: broad/unknown-owner tasks may use `contextgate_get_context`; concrete review diffs may use `tokenopt_compile_evidence` with `task_type=review_diff`; exact file/symbol/endpoint/failing-test tasks should start with narrow source or graph evidence.",
    "When CodeGraph tools are visible, use `codegraph_context` for compact graph/source context and `codegraph_slice` only for exact missing slices. Do not duplicate a slot through both broker and graph if the first packet already covers it.",
    "",
    "- Broad repo, business/domain, build handoff, flow, review diff, runtime debug, and refactor-scope tasks may use TokenOpt evidence first.",
    "- Missing-artifact PBI, requirement, unit-test, review-memory, or review prompts should ask for the concrete artifact instead of exploring.",
    "- Security audit requires concrete diff/scope and exact security followups only.",
    "- Exact bug traces with file/class/function/line/failing test/repro evidence should use native narrow search/read first; use `tokenopt_failure_packet` only for long failure output.",
    "- Exact file/class/method tasks and small-repo direct edits should use normal narrow search/read unless the user asks for TokenOpt.",
    "- Copilot prompt files under `.github/prompts` provide native slash prompts for common TokenOpt tasks.",
    "- If a packet says answerable=true, answer from it and avoid broad fallback.",
    "- For code changes, prefer unified diffs or compact edit plans instead of full-file rewrites."
  ].join("\n");
}

function reviewInstructionGraphContent(): string {
  return [
    "---",
    "applyTo: \"**/*.{java,ts,tsx,js,jsx,py,go,rs,kt,scala,cs}\"",
    "---",
    "",
    "# TokenOpt Review Tasks",
    "",
    "For PR/diff/code-review prompts, use the net diff as the code artifact and review in two phases: technical findings first, then business/test coverage gaps.",
    "",
    "- The user may only say \"review this PR\" or use a normal daily review prompt. Do not require the user to name TokenOpt, CodeGraph, or MCP.",
    "- If TokenOpt tools are visible and the prompt includes a concrete diff, PR, branch pair, changed files, file path, symbol, or exact review target, call `tokenopt_compile_evidence` with `task_type=review_diff` when it can replace broad source exploration.",
    "- If CodeGraph tools are visible, use `codegraph_context` for review/source graph context and `codegraph_slice` only for exact changed hunks, callers/callees, similar logic, or tests that remain missing.",
    "- If a review broker is available and can replace broad source exploration, use it as the slot checklist for changed files, changed symbols, business mapping, existing tests, missing tests, and compatibility risks.",
    "- If the diff already names exact files/symbols and the needed slots are narrow, use exact source/test reads or graph evidence directly instead of forcing a broker call.",
    "- If the prompt references a PR, use the net PR diff and PR merge/head worktree for follow-up context. Do not treat per-commit patch output as the final review state.",
    "- If the prompt references a branch pair, treat target/base branch and feature/head branch as review scope and review the net merge-base diff.",
    "- If the prompt includes Jira tickets, Confluence pages/URLs, or direct attachment summaries, use available connectors or the supplied attachment text as requirement evidence before business/test coverage review. Do not ask the user to paste full content when a connector can read it. If unavailable, state that requirement evidence is missing or assumption-based.",
    "- If the prompt has no diff, PR, changed files, file path, symbol, or exact target, ask for the review artifact and do not explore the repo.",
    "- For explicit security audit/review, require concrete scope and use exact security followups only. For normal code review, domain words such as security, auth, privilege, or permission do not by themselves switch to security_audit.",
    "- If the user provides a review checklist, preserve every item and return item-by-item coverage with pass, fail, gap, or not_applicable plus evidence.",
    "- In MCP full mode, use `tokenopt_prepare_java_diff` for Java diffs and `tokenopt_business_contract` for API/schema/security/messaging/test contracts.",
    "- Technical findings must be introduced, actionable defects with file, line, severity, evidence, and suggestion.",
    "- If TokenOpt evidence includes recall_probe facts, adjudicate each checked probe as a technical finding, coverage gap, or explicit non-issue with contrary evidence. Promote P1/P2 technical_finding_candidate=true probes unless contrary evidence disproves them.",
    "- Before returning no findings, check changed invariants, effective config/policy math, parser/encoding boundaries, backward compatibility, concurrency/async behavior, resource lifecycle, null/error paths, and call replacements.",
    "- Business/test coverage gaps must be separate from findings and should apply ISTQB dimensions: boundary values, equivalence partitions, negative/error cases, state transitions, concurrency/async, and compatibility/backward compatibility.",
    "- Do not downgrade a proven regression into a test gap.",
    "- Do not spend tokens on import reorder, whitespace, or Lombok-only changes unless they affect compile/runtime behavior."
  ].join("\n");
}

function runtimeInstructionGraphContent(): string {
  return [
    "---",
    "applyTo: \"**/*.{java,xml,yml,yaml,properties,gradle}\"",
    "---",
    "",
    "# TokenOpt Runtime And Java Tasks",
    "",
    "- Exact trace-bug tasks with a named file, class, function, line, failing test, stack frame, or repro path should use native narrow search/read directly.",
    "- Compress Java stack traces and Maven/Gradle logs before carrying them forward.",
    "- Preserve Caused by chains, user-code frames, first framework boundary, failing tests, and final build stats.",
    "- In MCP full mode, use `tokenopt_jakarta_annotation_filter` for Lombok-heavy entities and `tokenopt_assemble_spring_context` for actuator/beans JSON.",
    "- Allow one exact follow-up when runtime evidence is incomplete; avoid broad repo search after an answerable packet."
  ].join("\n");
}

function agentsInstructionGraphContent(): string {
  return [
    "## TokenOpt ContextGate",
    "",
    "Use TokenOpt selectively. Broad/review/debug/refactor tasks can use evidence packets; exact direct-file tasks should stay narrow.",
    "Respect coverage certificates: if answerable=true and missing=[], answer without broad fallback.",
    "Use compact diffs/edit plans for code changes and keep output concise."
  ].join("\n");
}

function writeMarkedInstructionBlock(filePath: string, content: string): void {
  const markerStart = "<!-- tokenopt:instruction-graph:start -->";
  const markerEnd = "<!-- tokenopt:instruction-graph:end -->";
  const block = `${markerStart}\n${content.trimEnd()}\n${markerEnd}`;
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const next = existing.includes(markerStart) && existing.includes(markerEnd)
    ? existing.replace(new RegExp(`${escapeRegExp(markerStart)}[\\s\\S]*?${escapeRegExp(markerEnd)}`), block)
    : `${existing.trimEnd()}${existing.trim().length > 0 ? "\n\n" : ""}${block}\n`;
  fs.writeFileSync(filePath, next, "utf8");
}

function instructionTargetPath(repoRoot: string, target: Exclude<InstructionTarget, "generic">): string {
  if (target === "copilot") {
    return path.join(repoRoot, ".github", "copilot-instructions.md");
  }
  if (target === "copilot-path") {
    return path.join(repoRoot, ".github", "instructions", "tokenopt.instructions.md");
  }
  if (target === "copilot-agent") {
    return path.join(repoRoot, ".github", "agents", "tokenopt-cost-gate.agent.md");
  }
  return path.join(repoRoot, "AGENTS.md");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findInstructionFiles(repoRoot: string): string[] {
  const candidates = [
    path.join(repoRoot, "AGENTS.md"),
    path.join(repoRoot, ".github", "copilot-instructions.md")
  ];
  const instructionDir = path.join(repoRoot, ".github", "instructions");
  if (fs.existsSync(instructionDir)) {
    for (const entry of fs.readdirSync(instructionDir)) {
      if (entry.endsWith(".instructions.md")) {
        candidates.push(path.join(instructionDir, entry));
      }
    }
  }
  const agentDir = path.join(repoRoot, ".github", "agents");
  if (fs.existsSync(agentDir)) {
    for (const entry of fs.readdirSync(agentDir)) {
      if (entry.endsWith(".agent.md")) {
        candidates.push(path.join(agentDir, entry));
      }
    }
  }
  return candidates.filter((candidate) => fs.existsSync(candidate));
}

function auditFile(filePath: string): AuditFile {
  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 12);
  const seen = new Set<string>();
  let duplicateLines = 0;
  for (const line of lines) {
    const key = line.toLowerCase();
    if (seen.has(key)) {
      duplicateLines += 1;
    }
    seen.add(key);
  }

  return {
    path: filePath,
    bytes: Buffer.byteLength(text, "utf8"),
    estimatedTokens: estimateTokens(text.length),
    duplicateLines,
    conflicts: detectConflicts(text)
  };
}

function detectConflicts(text: string): string[] {
  const conflicts: string[] = [];
  if (/\bnpm\b/i.test(text) && /\bpnpm\b/i.test(text)) {
    conflicts.push("Mentions both npm and pnpm; clarify package manager precedence.");
  }
  if (/\byarn\b/i.test(text) && /\bpnpm\b/i.test(text)) {
    conflicts.push("Mentions both yarn and pnpm; clarify package manager precedence.");
  }
  if (/never\s+use\s+tests?/i.test(text) && /run\s+tests?/i.test(text)) {
    conflicts.push("Contains both test avoidance and test-running guidance.");
  }
  return conflicts;
}

function formatAudit(audit: AuditFile, repoRoot: string): string[] {
  const rel = path.relative(repoRoot, audit.path) || audit.path;
  const warnings = [
    audit.estimatedTokens > 1500 ? "Large instruction file; consider path-specific split." : undefined,
    audit.duplicateLines > 0 ? `${audit.duplicateLines} duplicate-looking lines.` : undefined,
    ...audit.conflicts
  ].filter((item): item is string => Boolean(item));
  return [
    `- ${rel}`,
    `  bytes: ${audit.bytes}`,
    `  estimatedTokens: ${audit.estimatedTokens}`,
    `  findings: ${warnings.length > 0 ? warnings.join(" ") : "none"}`
  ];
}
