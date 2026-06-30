export interface GatewayRequirementArtifact {
  source: "jira" | "confluence" | "github" | "attachment" | "other";
  id?: string;
  title?: string;
  url?: string;
  summary?: string;
  text?: string;
}

export interface GatewayCodeContextRequest {
  task: string;
  cwd: string;
  requiredSlots: string[];
  budgetTokens?: number;
}

export interface GatewayCodeContext {
  provider: "contextgate" | "codegraph" | "tokenopt" | "other";
  answerable: boolean;
  evidence: unknown;
  missing: string[];
}

export interface GatewayUpstreamAdapter {
  getRequirement(input: { keyOrUrl: string; cwd: string }): Promise<GatewayRequirementArtifact | undefined>;
  getConfluenceContext(input: { queryOrUrl: string; cwd: string }): Promise<GatewayRequirementArtifact[]>;
  getCodeContext(input: GatewayCodeContextRequest): Promise<GatewayCodeContext>;
}

