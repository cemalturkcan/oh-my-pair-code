// ── Single source of truth for agent MCP access ───────────────────
// When adding/removing an MCP, update ONLY this file.

import type { McpToggles } from "../types";

export type McpName =
  | "context7"
  | "grep_app"
  | "searxng"
  | "web-agent-mcp"
  | "pg-mcp"
  | "ssh-mcp"
  | "mariadb";

/** Human-readable description for each MCP, used in prompts. */
export const MCP_DESCRIPTIONS: Record<McpName, string> = {
  context7: "Library/framework docs.",
  grep_app: "GitHub code search.",
  searxng: "Web search + URL read.",
  "web-agent-mcp": "Browser automation.",
  "pg-mcp": "PostgreSQL read-only queries.",
  "ssh-mcp": "Remote commands.",
  mariadb: "MariaDB queries.",
};

/** All available MCP names. */
export const ALL_MCPS: McpName[] = Object.keys(MCP_DESCRIPTIONS) as McpName[];

/** MCPs each agent is DENIED. Unlisted agents have no MCP access. */
export const AGENT_MCP_DENIED: Record<string, McpName[]> = {
  yang: ["searxng", "web-agent-mcp"],
  thorfinn: ["searxng", "web-agent-mcp"],
  ginko: ["web-agent-mcp", "pg-mcp", "ssh-mcp", "mariadb"],
  rust: ["searxng", "web-agent-mcp", "pg-mcp", "ssh-mcp", "mariadb"],
  rust_deep: ["searxng", "web-agent-mcp", "pg-mcp", "ssh-mcp", "mariadb"],
  spock: ["context7", "searxng", "grep_app", "web-agent-mcp", "pg-mcp", "ssh-mcp", "mariadb"],
  geralt: ["searxng", "grep_app", "web-agent-mcp"],
  edward: ["pg-mcp", "ssh-mcp", "mariadb"],
  killua: ["context7", "searxng", "grep_app", "web-agent-mcp", "pg-mcp", "ssh-mcp", "mariadb"],
};

function isMcpEnabled(mcp: McpName, mcps?: McpToggles): boolean {
  if (!mcps) return true;
  const key = mcp.replace(/-/g, "_") as keyof McpToggles;
  return mcps[key] !== false;
}

/** Get the list of MCPs an agent CAN access. */
export function getAllowedMcps(agent: string, mcps?: McpToggles): McpName[] {
  const denied = new Set(AGENT_MCP_DENIED[agent] ?? ALL_MCPS);
  return ALL_MCPS.filter((mcp) => !denied.has(mcp) && isMcpEnabled(mcp, mcps));
}

/** Build OpenCode tool deny rules for an agent. */
export function buildDenyRules(agent: string): Record<string, string> {
  const denied = AGENT_MCP_DENIED[agent] ?? ALL_MCPS;
  if (denied.length === 0) return {};
  const rules: Record<string, string> = {};
  for (const mcp of denied) {
    rules[`${mcp}_*`] = "deny";
  }
  return rules;
}

/** Build a <McpGuidance> prompt section for a worker agent. */
export function buildMcpGuidance(agent: string, mcps?: McpToggles): string {
  const allowed = getAllowedMcps(agent, mcps);
  if (allowed.length === 0) return "";
  return `\n<McpGuidance>\nMCP: ${allowed.join(", ")}.\n</McpGuidance>`;
}

/** Build "MCP: x, y, z" summary for the worker catalog. */
export function buildMcpSummary(agent: string, mcps?: McpToggles): string {
  const allowed = getAllowedMcps(agent, mcps);
  if (allowed.length === 0) return "Tools: Glob, Grep, Bash. No MCPs needed.";
  return `MCP: ${allowed.join(", ")}.`;
}
