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
  context7: "Library/framework docs.",
  grep_app: "GitHub code search.",
  searxng: "Web search + URL read.",
  "web-agent-mcp": "Browser automation.",
  "pg-mcp": "PostgreSQL read-only queries.",
  "ssh-mcp": "Remote commands.",
  "openai-image-gen-mcp": "Image generation via Codex auth.",
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

export function buildMcpGuidance(
  mcps?: McpToggles,
  skillNames?: readonly string[],
): string {
  const enabled = getEnabledMcps(mcps);
  if (enabled.length === 0) return "";
  const installedSkills = resolveInstalledSkills(skillNames);
  const lines = [
    `Shared MCPs for every agent: ${enabled.join(", ")}. Use the tool that best fits the task.`,
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
