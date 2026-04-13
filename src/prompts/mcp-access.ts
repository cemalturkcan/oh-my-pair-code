import type { McpToggles } from "../types";

export type McpName =
  | "context7"
  | "grep_app"
  | "searxng"
  | "web-agent-mcp"
  | "pg-mcp"
  | "ssh-mcp"
  | "mariadb";

export const MCP_DESCRIPTIONS: Record<McpName, string> = {
  context7: "Library/framework docs.",
  grep_app: "GitHub code search.",
  searxng: "Web search + URL read.",
  "web-agent-mcp": "Browser automation.",
  "pg-mcp": "PostgreSQL read-only queries.",
  "ssh-mcp": "Remote commands.",
  mariadb: "MariaDB queries.",
};

export const ALL_MCPS: McpName[] = Object.keys(MCP_DESCRIPTIONS) as McpName[];

function isMcpEnabled(mcp: McpName, mcps?: McpToggles): boolean {
  if (!mcps) return true;
  const key = mcp.replace(/-/g, "_") as keyof McpToggles;
  return mcps[key] !== false;
}

export function getEnabledMcps(mcps?: McpToggles): McpName[] {
  return ALL_MCPS.filter((mcp) => isMcpEnabled(mcp, mcps));
}

export function buildMcpGuidance(mcps?: McpToggles): string {
  const enabled = getEnabledMcps(mcps);
  if (enabled.length === 0) return "";
  return `\n<McpGuidance>\nShared MCPs for every agent: ${enabled.join(", ")}. Use the tool that best fits the task.\n</McpGuidance>`;
}

export function buildMcpSummary(mcps?: McpToggles): string {
  const enabled = getEnabledMcps(mcps);
  if (enabled.length === 0) return "Tools: Glob, Grep, Bash. No MCPs enabled.";
  return `Shared MCPs: ${enabled.join(", ")}.`;
}
