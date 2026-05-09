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
    "Browser automation for navigating pages, interacting with controls, observing DOM/a11y/text/network state, screenshots, local web app verification, and read-only session/page status recovery.",
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
    "Shared MCP routing cards. Use orchestrator_tool_preflight when MCP/tool family, cheapest first action, expected evidence, fallback, or risk/budget is unclear; it is deterministic and side-effect free. Use the narrowest enabled family that fits; down-rank risky or expensive tools until cheaper evidence is insufficient.",
    ...buildMcpRoutingCards(enabled),
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

export function buildMcpRoutingCards(enabled: readonly McpName[]): string[] {
  const has = (mcp: McpName) => enabled.includes(mcp);
  const cards: string[] = [];

  if (has("web-agent-mcp")) {
    cards.push(
      "- Browser (web-agent-mcp): use the global local-only web-agent daemon for real browser interaction, local web app verification, auth flow classification, console/network/DOM/a11y inspection, and screenshots only when visual proof is needed; do not assume a fresh per-terminal ephemeral browser. First call: session.status to recover daemon/session state and read all visible tabs; any local agent can see and control all tabs, so target subsequent tools by page_id or tab_id. For login/form flows, stay browser-first: use session.status plus page_state/DOM/text/a11y observations before acting, prefer selectors seen in those observations before guessed IDs, and do not do repo Glob/Grep/Read unless credentials, fixtures, route source, or app internals are actually needed. Use page.create when a new tab is needed and include purpose/owner metadata for human traceability only; purpose/owner are informational and are not access controls or tab restrictions. The daemon uses a persistent global browser profile: cookies, history, localStorage, and profile data survive OpenCode terminal exits and daemon/browser restarts, but live DOM state, JS heap memory, and in-flight page state may not survive a daemon or browser restart. Avoid/down-rank for static web reading, API docs, or when text/DOM evidence is enough; avoid networkidle as a default readiness check because it waits for no network connections and can be slow. Cheaper alternative: observe_text or observe_dom before page_state/screenshot; use observe_console/network/page-state, explicit wait_for selector/text, or observe_wait_for_network for app readiness. Use page.resize for responsive checks, observe_screenshot with viewport/full/element mode when visual proof is needed, runtime.inject_css/remove_css for bounded style experiments, runtime.run_page_script for bounded internal test/diagnostic flows, and runtime.evaluate_js for single-expression page reads. Use human-like act.* tools for interaction-sensitive flows. For act.fill/click/press/enter_code, omit frame_selector for main-page elements; only pass frame_selector after observing a real iframe selector, never placeholders such as body, :scope, __none__, or iframe#__none__. After act.click/act.press, read post_action guidance to distinguish no observable change from a successful action with app effects needing a follow-up observation; after timeouts, observe state before retrying instead of repeating blind fills/clicks. Recovery: on BROWSER_DISCONNECTED or stale ids, stop retrying the stale session/page/tab id; call session.status, retarget an existing visible tab by page_id/tab_id, use page.create if a new tab is needed, or restart the daemon only when status/health shows the daemon is bad. Use observe_auth_state for auth failures and observe_console/network for runtime failures.",
    );
  }

  if (has("context7") || has("searxng") || has("grep_app")) {
    const tools = [
      has("context7") && "context7",
      has("searxng") && "searxng",
      has("grep_app") && "grep_app",
    ]
      .filter(Boolean)
      .join(", ");
    const toolGuidance = [
      has("context7") &&
        "context7 for current library/framework docs; first call context7_resolve-library-id before context7_query-docs; recover by retrying query-docs with researchMode only when normal docs are insufficient",
      has("searxng") &&
        "searxng for general/current web sources and URL reading; first call searxng_web_search before URL reads; recover by cross-checking web claims",
      has("grep_app") &&
        "grep_app for literal public GitHub code patterns; first call grep_app_searchGitHub with code-shaped literals; recover by narrowing language/path/repo",
    ]
      .filter(Boolean)
      .join("; ");
    cards.push(
      `- Research/Search (${tools}): ${toolGuidance}. Avoid/down-rank broad external research when repo evidence or official docs answer it; never use public code search for keyword/tutorial searches. Cheaper alternative: local Grep/Read for repo-local questions. Recovery: state uncertainty instead of guessing.`,
    );
  }

  if (has("pg-mcp") || has("mariadb")) {
    const tools = [has("pg-mcp") && "pg-mcp", has("mariadb") && "mariadb"]
      .filter(Boolean)
      .join(", ");
    const engines = [
      has("pg-mcp") && "pg-mcp for PostgreSQL",
      has("mariadb") && "mariadb for MariaDB/MySQL",
    ]
      .filter(Boolean)
      .join("; ");
    cards.push(
      `- Database (${tools}): use only for read-only schema/data inspection; choose ${engines}. Avoid/down-rank when code/config already proves the answer, when writes/migrations are needed, or when production risk is unclear. First call: list_connections, then list_databases/schemas/tables or describe_table before SELECT. Cheaper alternative: inspect migrations, fixtures, ORM models, or docs in the repo. Recovery: keep SELECT row limits small, use EXPLAIN/DESCRIBE for shape questions, suggest manual queries for unsafe operations, and stop before any write or destructive action.`,
    );
  }

  if (has("ssh-mcp")) {
    cards.push(
      "- Remote/SSH (ssh-mcp): use for bounded non-interactive remote inspection or commands only when local/repo evidence cannot answer and the configured host is necessary. Avoid/down-rank for routine local checks, destructive operations, deployments, or commands that may prompt. First call: list_hosts or test_connection for the target host. Cheaper alternative: local Bash/Read/Grep or ledger context. Recovery: use strict timeouts and non-interactive flags, capture compact evidence only, and stop for missing approval, unclear host, production write, or destructive risk.",
    );
  }

  if (has("openai-image-gen-mcp")) {
    cards.push(
      "- Image (openai-image-gen-mcp): use only for requested image generation/editing through Codex auth. Avoid/down-rank for text-only prompt drafting, UI implementation, or when no visual output is requested. First call: load the image-prompting skill first as specified below, then generate_image for new images or edit_image only with input_images/previous response IDs. Cheaper alternative: provide a written prompt/brief without calling the image MCP. Recovery: inspect auth status for auth failures, preserve source_prompt/source_prompt_preview handling, and do not fabricate generated outputs.",
    );
  }

  cards.push(
    "- Ledger/Context (orchestrator tools): use for mission/task truth, dependencies, evidence, durable decisions, blockers, verification gates, tool_preflight/research_route planning, and handoffs. Avoid/down-rank raw transcript reliance or duplicating the same data as both artifact and context. First call: session_current/get_current_task when assigned; Mission Control starts with project_resolve/session_attach; use orchestrator_tool_preflight when tool-family risk/budget is unclear, and orchestrator_research_route before external research when route/query quality is unclear. Cheaper alternative: direct task packet fields when sufficient. Recovery: artifact=evidence/output/test logs/API responses; context=reusable handoff/search/compact knowledge. Compact before publishing large findings and reopen/report blockers when evidence is missing.",
  );

  return cards;
}

export function buildMcpSummary(mcps?: McpToggles): string {
  const enabled = getEnabledMcps(mcps);
  if (enabled.length === 0) return "Tools: Glob, Grep, Bash. No MCPs enabled.";
  return `Shared MCPs: ${enabled.join(", ")}.`;
}
