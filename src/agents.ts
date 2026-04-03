import type { AgentLike, HarnessConfig } from "./types";
import { deepMerge } from "./utils";
import {
  buildCoordinatorPrompt,
  buildCoordinatorPromptExp,
} from "./prompts/coordinator";
import {
  buildWorkerPrompt,
  buildResearcherPrompt,
  buildReviewerPrompt,
  buildYetAnotherReviewerPrompt,
  buildVerifierPrompt,
  buildRepairPrompt,
  buildUiDeveloperPrompt,
  buildRepoScoutPrompt,
} from "./prompts/workers";

function withOverride(
  base: AgentLike,
  override?: Record<string, unknown>,
): AgentLike {
  if (!override) return base;
  return deepMerge(base, override);
}

function taskPermissions(...allowedPatterns: string[]) {
  const permissions: Record<string, string> = { "*": "deny" };
  for (const pattern of allowedPatterns) {
    permissions[pattern] = "allow";
  }
  return permissions;
}

const COORDINATOR_TASK_PERMISSIONS = taskPermissions(
  "memati",
  "abdulhey",
  "aslan-akbey",
  "iskender",
  "halit",
  "tuncay",
  "ebru",
  "laz-ziya",
);

// Only the expensive MCPs are disabled on the coordinator (~30k token savings).
// Lighter MCPs stay open so the coordinator can use them directly.
const COORDINATOR_DISABLED_TOOLS: Record<string, string> = {
  "jina_*": "deny",
  "web-agent-mcp_*": "deny",
  "figma-console_*": "deny",
};

// Per-worker MCP restrictions: disable MCPs they don't need.
function mcpDenyRules(
  ...disabledPrefixes: string[]
): Record<string, string> {
  const tools: Record<string, string> = {};
  for (const prefix of disabledPrefixes) {
    tools[`${prefix}_*`] = "deny";
  }
  return tools;
}

export function createHarnessAgents(
  config: HarnessConfig,
): Record<string, AgentLike> {
  const overrides = config.agents ?? {};

  return {
    // ── Coordinator (primary agent) ──────────────────────────────
    polat: withOverride(
      {
        mode: "primary",
        description:
          "Polat Alemdar — Derin operasyon şefi. Planlar, yönetir, senkronize eder.",
        model: "openai/gpt-5.4",
        variant: "xhigh",
        prompt: buildCoordinatorPrompt(overrides.polat?.prompt_append),
        color: "#1a5276",
        tools: COORDINATOR_DISABLED_TOOLS,
        permission: { task: COORDINATOR_TASK_PERMISSIONS },
      },
      overrides.polat,
    ),

    "polat-exp": withOverride(
      {
        mode: "primary",
        description:
          "Polat Alemdar (Deneysel) — Yargı tabanlı delegasyon koordinatörü.",
        model: "openai/gpt-5.4",
        variant: "xhigh",
        prompt: buildCoordinatorPromptExp(overrides["polat-exp"]?.prompt_append),
        color: "#6c3483",
        tools: COORDINATOR_DISABLED_TOOLS,
        permission: { task: COORDINATOR_TASK_PERMISSIONS },
      },
      overrides["polat-exp"],
    ),

    // ── Workers (subagents) ──────────────────────────────────────
    memati: withOverride(
      {
        mode: "subagent",
        hidden: true,
        description: "Memati Baş — Genel amaçlı uygulama çalışanı.",
        model: "openai/gpt-5.4",
        variant: "high",
        prompt: buildWorkerPrompt(overrides.memati?.prompt_append),
        temperature: 0.2,
        color: "#27ae60",
        tools: mcpDenyRules("jina", "web-agent-mcp", "figma-console"),
      },
      overrides.memati,
    ),

    abdulhey: withOverride(
      {
        mode: "subagent",
        hidden: true,
        description: "Abdülhey — Web ve belge araştırmacısı.",
        model: "openai/gpt-5.4",
        variant: "none",
        prompt: buildResearcherPrompt(overrides.abdulhey?.prompt_append),
        temperature: 0.3,
        color: "#F39C12",
        tools: mcpDenyRules(
          "web-agent-mcp",
          "figma-console",
          "pg-mcp",
          "ssh-mcp",
          "mariadb",
        ),
      },
      overrides.abdulhey,
    ),

    "aslan-akbey": withOverride(
      {
        mode: "subagent",
        hidden: true,
        description:
          "Aslan Akbey — Kıdemli kod incelemecisi. İnce hataları ve güvenlik sorunlarını bulur.",
        model: "openai/gpt-5.4",
        variant: "xhigh",
        prompt: buildReviewerPrompt(overrides["aslan-akbey"]?.prompt_append),
        temperature: 0.1,
        color: "#E74C3C",
        tools: mcpDenyRules(
          "jina",
          "websearch",
          "web-agent-mcp",
          "figma-console",
          "pg-mcp",
          "ssh-mcp",
          "mariadb",
        ),
        permission: {
          edit: "deny",
          bash: { "*": "deny" },
        },
      },
      overrides["aslan-akbey"],
    ),

    iskender: withOverride(
      {
        mode: "subagent",
        hidden: true,
        description:
          "İskender Büyük — Çapraz model bağımsız incelemeci.",
        model: "openai/gpt-5.4",
        variant: "xhigh",
        prompt: buildYetAnotherReviewerPrompt(overrides.iskender?.prompt_append),
        temperature: 0.4,
        color: "#9B59B6",
        tools: mcpDenyRules(
          "jina",
          "websearch",
          "web-agent-mcp",
          "figma-console",
          "pg-mcp",
          "ssh-mcp",
          "mariadb",
        ),
        permission: {
          edit: "deny",
          bash: { "*": "deny" },
        },
      },
      overrides.iskender,
    ),

    halit: withOverride(
      {
        mode: "subagent",
        hidden: true,
        description: "Cerrahpaşalı Halit — Derleme, test, lint doğrulayıcı.",
        model: "openai/gpt-5.4-mini",
        variant: "none",
        prompt: buildVerifierPrompt(overrides.halit?.prompt_append),
        temperature: 0.0,
        color: "#95A5A6",
        tools: mcpDenyRules(
          "context7",
          "jina",
          "websearch",
          "grep_app",
          "web-agent-mcp",
          "figma-console",
          "pg-mcp",
          "ssh-mcp",
          "mariadb",
        ),
      },
      overrides.halit,
    ),

    tuncay: withOverride(
      {
        mode: "subagent",
        hidden: true,
        description: "Tuncay Kantarcı — Kapsamlı hata tamircisi.",
        model: "openai/gpt-5.4",
        variant: "high",
        prompt: buildRepairPrompt(overrides.tuncay?.prompt_append),
        temperature: 0.1,
        color: "#E67E22",
        tools: mcpDenyRules(
          "jina",
          "websearch",
          "grep_app",
          "web-agent-mcp",
          "figma-console",
        ),
      },
      overrides.tuncay,
    ),

    ebru: withOverride(
      {
        mode: "subagent",
        hidden: true,
        description:
          "Ebru Duru — Figma ve tarayıcı otomasyonu ile frontend uzmanı.",
        model: "openai/gpt-5.4",
        variant: "high",
        prompt: buildUiDeveloperPrompt(overrides.ebru?.prompt_append),
        temperature: 0.5,
        color: "#FF69B4",
        tools: mcpDenyRules("pg-mcp", "ssh-mcp", "mariadb"),
      },
      overrides.ebru,
    ),

    "laz-ziya": withOverride(
      {
        mode: "subagent",
        hidden: true,
        description: "Laz Ziya — Hızlı kod tabanı kaşifi.",
        model: "openai/gpt-5.4-mini",
        variant: "none",
        prompt: buildRepoScoutPrompt(overrides["laz-ziya"]?.prompt_append),
        temperature: 0.1,
        color: "#1ABC9C",
        tools: mcpDenyRules(
          "context7",
          "jina",
          "websearch",
          "grep_app",
          "web-agent-mcp",
          "figma-console",
          "pg-mcp",
          "ssh-mcp",
          "mariadb",
        ),
      },
      overrides["laz-ziya"],
    ),

    // ── Disable OpenCode built-in agents ─────────────────────────
    build: { disable: true },
    plan: { disable: true },
  };
}
