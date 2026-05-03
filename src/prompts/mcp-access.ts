import type { McpToggles } from "../types";
import { resolveInstalledSkills } from "../skills";

export type McpName =
  | "context7"
  | "grep_app"
  | "searxng"
  | "web-agent-mcp"
  | "pg-mcp"
  | "ssh-mcp"
  | "openai-image-gen-mcp"
  | "mariadb";

export const MCP_DESCRIPTIONS: Record<McpName, string> = {
  context7:
    "Library and framework documentation with version-aware examples for current API usage and implementation details.",
  grep_app:
    "Literal code search across public GitHub repositories for real-world usage patterns, API examples, and implementation references.",
  searxng:
    "General web search plus URL reading for broad research, recent information, official docs, articles, and source cross-checking.",
  "web-agent-mcp":
    "Browser automation for navigating pages, interacting with controls, observing DOM/a11y/text/network state, screenshots, and local web app verification.",
  "pg-mcp":
    "Read-only PostgreSQL inspection: list connections/databases/schemas/tables, describe tables, and run SELECT queries with row limits.",
  "ssh-mcp":
    "Remote command execution against configured SSH hosts, including connectivity checks and bounded non-interactive commands.",
  "openai-image-gen-mcp":
    "Image generation and image editing through Codex auth using OpenAI image-generation tooling, with PNG/high-quality/auto-size defaults fixed server-side.",
  mariadb:
    "Read-only MariaDB inspection: list connections/databases/tables, describe tables, run SELECT/SHOW/DESCRIBE/EXPLAIN queries, and suggest manual queries.",
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

export function buildMcpGuidance(
  mcps?: McpToggles,
  skillNames?: readonly string[],
): string {
  const enabled = getEnabledMcps(mcps);
  if (enabled.length === 0) return "";
  const installedSkills = resolveInstalledSkills(skillNames);
  const lines = [
    "Shared MCPs for every agent:",
    ...enabled.map((mcp) => `- ${mcp}: ${MCP_DESCRIPTIONS[mcp]}`),
    "Use the tool that best fits the task.",
  ];

  if (enabled.includes("openai-image-gen-mcp")) {
    if (installedSkills.includes("image-prompting")) {
      lines.push(
        "For openai-image-gen-mcp: call the Skill tool directly with name `image-prompting` first; do not rely on skill_find for this path. Build the final image prompt as JSON, pass it in `prompt_json`, use generate_image for new images, use edit_image only when you have input_images or a previous image response/id, and remember that the MCP bridge serializes that JSON and forwards source_prompt verbatim without rewriting it. PNG output, high quality, auto size, and auto background are fixed by the server. output_path is a file path, so use output_name plus base_dir when you only know the target folder. After a successful image call, surface the returned `source_prompt_preview` in your reply so the user can see what was sent; include `source_prompt` when they ask for the exact prompt text.",
      );
    } else {
      lines.push(
        "For openai-image-gen-mcp: load `image-prompting` first only if it is installed or skill_find confirms it exists; otherwise do not call skill_use blindly.",
      );
    }
  }

  return `\n<McpGuidance>\n${lines.join("\n")}\n</McpGuidance>`;
}

export function buildMcpSummary(mcps?: McpToggles): string {
  const enabled = getEnabledMcps(mcps);
  if (enabled.length === 0) return "Tools: Glob, Grep, Bash. No MCPs enabled.";
  return `Shared MCPs: ${enabled.join(", ")}.`;
}
