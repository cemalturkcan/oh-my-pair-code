import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  AcceptanceCriterion,
  OrchestratorLedger,
  TaskPriority,
  TaskStatus,
  TaskType,
  TaskVerification,
  BacklogStatus,
  ProjectSensitivityProfileEntryKind,
  ProjectSensitivityProfileSource,
  SessionStatus,
} from "./ledger";
import { canonicalLockScope, normalizeOptionalID } from "./ledger";
import { WORKER_AGENTS } from "./constants";
import { buildLedgerSyncPlan, reconcileLedgerSnapshots, reconcileLedgerSqliteSnapshots, type LedgerSyncPhase } from "./sync";
import type { HarnessConfig } from "../types";

const s = tool.schema;

const taskStatusSchema = s.enum([
  "pending",
  "in_progress",
  "blocked",
  "needs_verification",
  "reopened",
  "done",
  "cancelled",
]);

const taskPrioritySchema = s.enum(["low", "medium", "high", "critical"]);

const taskTypeSchema = s.enum([
  "implementation",
  "frontend",
  "repo_scout",
  "research",
  "verification",
  "docs",
  "other",
]);

const workerAgentSchema = s.enum(WORKER_AGENTS);
const backlogStatusSchema = s.enum(["none", "backlog", "ready", "planned"]);
const sessionStatusSchema = s.enum(["active", "idle", "ended", "crashed"]);
const researchIntentSchema = s.enum([
  "official_docs",
  "real_world_code",
  "current_web",
  "known_url",
  "repo_local",
  "broad_research",
]);
const toolPreflightIntentSchema = s.enum([
  "browser_interaction",
  "browser_debug",
  "database_read",
  "remote_ssh",
  "image_generation_or_edit",
  "ledger_context",
  "research",
  "local_repo",
]);
const guardActionSchema = s.enum(["write", "git_read", "git_write", "secret_env_write", "lock", "unknown_edit"]);
const sensitivityKindSchema = s.enum(["hard_constraint", "preference", "tool_policy", "risk_flag", "repo_note"]);
const sensitivitySourceSchema = s.enum(["repo_detected", "user", "mission", "config", "tool"]);
const sensitivityRiskSchema = s.enum(["security", "data_loss", "external_write", "auth_state", "git_history", "custom"]);
const ledgerSyncPhaseSchema = s.enum([
  "manual",
  "session_start",
  "checkpoint",
  "session_end",
  "crash_recovery",
]);

type ResearchIntent = "official_docs" | "real_world_code" | "current_web" | "known_url" | "repo_local" | "broad_research";
type ToolPreflightIntent = "browser_interaction" | "browser_debug" | "database_read" | "remote_ssh" | "image_generation_or_edit" | "ledger_context" | "research" | "local_repo";
type GuardAction = "write" | "git_read" | "git_write" | "secret_env_write" | "lock" | "unknown_edit";

type GuardPreflight = {
  action: GuardAction;
  allowed: boolean;
  reason_code: string;
  normalized_paths: string[];
  required_lock_scope: string | null;
  safe_helper: string;
  recovery: string;
  retry_policy: string;
  secret_handling: string;
  caveats: string[];
};

type SecretEnvWriteResult = {
  ok: boolean;
  status: "written" | "blocked";
  target_path: string;
  normalized_path: string;
  keys: string[];
  value_count: number;
  value_hashes: Record<string, string>;
  evidence: string[];
  error?: string;
  blocker?: string;
};

type ResearchRoute = {
  intent: ResearchIntent;
  route: string[];
  query_rewrite_hints: string[];
  fallback_order: string[];
  max_call_budget: number;
  evidence_expectations: string[];
  no_external_call: boolean;
};

type ToolPreflight = {
  intent: ToolPreflightIntent;
  family: string;
  recommended_tools: string[];
  cheapest_first_action: string;
  expected_evidence: string[];
  fallback: string[];
  avoid_or_stop_rules: string[];
  risk: "low" | "medium" | "high";
  cost: "none" | "low" | "medium" | "high";
  budget: string;
  side_effect_free: true;
};

const criterionSchema = s.object({
  criterion: s.string().min(1).describe("Acceptance criterion text."),
  met: s.boolean().optional().describe("Whether this criterion has been met."),
  evidence: s.string().optional().describe("Compact evidence proving the result."),
  verification_type: s
    .string()
    .optional()
    .describe("real_request | local_test | unit_test | build | browser | db_read | manual_reasoning | other"),
});

const verificationSchema = s.object({
  mode: s.enum(["real", "sandbox", "local", "mock", "not_run"]).optional(),
  commands_or_actions: s.array(s.string()).optional(),
  result: s.enum(["pass", "fail", "partial", "blocked"]).optional(),
  why_not_real: s.string().nullable().optional(),
  low_risk_exception: s.string().nullable().optional(),
});

const optionalIDSchema = s
  .string()
  .nullable()
  .optional()
  .describe("Optional ledger id. Omit when absent; '', whitespace, 'null', 'none', and 'undefined' are treated as absent.");

function json(value: unknown): string {
  return JSON.stringify(value);
}

function errorJson(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return json({ ok: false, error: "ledger_error", message, recovery: "Check the named id field, use an existing ledger id, or omit/pass null/none for optional relationships." });
}

function detectResearchIntent(input: { intent?: ResearchIntent; query?: string; url?: string; repo_local?: boolean }): ResearchIntent {
  if (input.intent) return input.intent;
  if (input.repo_local) return "repo_local";
  if (input.url || /^https?:\/\//i.test(input.query ?? "")) return "known_url";
  const query = (input.query ?? "").toLowerCase();
  if (/\b(latest|current|recent|today|news|pricing|release|version|changed|now)\b/.test(query)) return "current_web";
  if (/\b(example|examples|real[- ]world|github|usage pattern|implementation pattern|code search)\b/.test(query)) return "real_world_code";
  if (/\b(docs?|api|reference|framework|library|sdk|package|version)\b/.test(query)) return "official_docs";
  if (/\b(repo|local|codebase|this project|in this repository)\b/.test(query)) return "repo_local";
  return "broad_research";
}

export function buildResearchRoute(input: { intent?: ResearchIntent; query?: string; url?: string; repo_local?: boolean }): ResearchRoute {
  const intent = detectResearchIntent(input);
  const compactQuery = (input.query ?? input.url ?? "").trim();
  const common = { intent, no_external_call: intent === "repo_local" } as const;

  if (intent === "official_docs") {
    return {
      ...common,
      route: ["context7_resolve-library-id", "context7_query-docs"],
      query_rewrite_hints: ["Name the exact library/framework and version when known.", "Ask for the specific API, option, migration, or behavior, not a broad topic.", compactQuery ? `Seed query: ${compactQuery}` : "Keep the query short and API-shaped."],
      fallback_order: ["context7_query-docs researchMode=true", "searxng_web_search official docs", "searxng_web_url_read"],
      max_call_budget: 3,
      evidence_expectations: ["library id/version", "official doc snippet or URL", "note uncertainty if docs are missing"],
    };
  }

  if (intent === "real_world_code") {
    return {
      ...common,
      route: ["grep_app_searchGitHub"],
      query_rewrite_hints: ["Search literal code that would appear in files; avoid tutorial keywords.", "Use language/path/repo filters to narrow noisy patterns.", compactQuery ? `Rewrite toward a code literal from: ${compactQuery}` : "Prefer imports, function calls, decorators, or config keys."],
      fallback_order: ["narrow grep_app_searchGitHub filters", "context7 official docs", "searxng_web_search targeted source"],
      max_call_budget: 3,
      evidence_expectations: ["repository/path/language", "observed pattern", "why the example is relevant"],
    };
  }

  if (intent === "current_web") {
    return {
      ...common,
      route: ["searxng_web_search", "searxng_web_url_read"],
      query_rewrite_hints: ["Include recency terms only when time-sensitive.", "Prefer official source names, release pages, pricing pages, or changelogs.", compactQuery ? `Search query: ${compactQuery}` : "Use a specific entity plus the current fact needed."],
      fallback_order: ["read top official result", "cross-check second source", "state date/uncertainty"],
      max_call_budget: 4,
      evidence_expectations: ["source URL", "publication/update date when available", "cross-check for volatile claims"],
    };
  }

  if (intent === "known_url") {
    return {
      ...common,
      route: ["searxng_web_url_read"],
      query_rewrite_hints: ["Read the provided URL directly before searching.", "Use section or paragraph targeting when only part of the page matters.", input.url ? `URL: ${input.url}` : compactQuery ? `URL candidate: ${compactQuery}` : "Provide a full URL."],
      fallback_order: ["searxng_web_search for the page title/domain", "official mirror or docs", "state inaccessible URL"],
      max_call_budget: 2,
      evidence_expectations: ["URL read", "relevant heading/section", "access failure reason if unreadable"],
    };
  }

  if (intent === "repo_local") {
    return {
      ...common,
      route: ["no_external_call", "local Glob/Grep/Read", "orchestrator_context_search"],
      query_rewrite_hints: ["Use repo symbols, file paths, config names, or error text.", "Search locally before any web/source lookup.", compactQuery ? `Local search seed: ${compactQuery}` : "Keep the search tied to repository evidence."],
      fallback_order: ["repo Grep/Read", "ledger context/artifacts", "ask for missing local evidence before web"],
      max_call_budget: 0,
      evidence_expectations: ["file paths and line references", "repo-local behavior", "explicit note that no external call was needed"],
    };
  }

  return {
    ...common,
    route: ["searxng_web_search", "searxng_web_url_read", "context7 or grep_app if narrowed"],
    query_rewrite_hints: ["Start broad, then classify into official docs, code examples, or current web.", "Use source-qualified terms and avoid vague best-practice searches.", compactQuery ? `Initial query: ${compactQuery}` : "Capture the entity, question, and desired evidence type."],
    fallback_order: ["official/source result", "independent corroborating source", "narrow to Context7 or grep.app"],
    max_call_budget: 4,
    evidence_expectations: ["source URLs", "summary tied to cited evidence", "uncertainty and gaps for unsupported claims"],
  };
}

export function buildToolPreflight(input: { intent: ToolPreflightIntent }): ToolPreflight {
  const common = { intent: input.intent, side_effect_free: true } as const;
  switch (input.intent) {
    case "browser_interaction":
      return { ...common, family: "browser", recommended_tools: ["web-agent-mcp"], cheapest_first_action: "web-agent-mcp_session_status; reuse an existing page when valid, otherwise session_create then page_navigate", expected_evidence: ["page/session id", "text/DOM observation before action", "post-action state or network evidence"], fallback: ["observe_text or observe_dom", "observe_page_state", "screenshot only for visual proof"], avoid_or_stop_rules: ["stop for auth/production side effects without approval", "prefer text/DOM over screenshot when enough"], risk: "medium", cost: "medium", budget: "start with one status/observation call; add interaction calls only after target evidence is known" };
    case "browser_debug":
      return { ...common, family: "browser", recommended_tools: ["web-agent-mcp"], cheapest_first_action: "observe_console or observe_network on the current page before broad page snapshots", expected_evidence: ["console entries", "network failures/responses", "DOM/text state tied to the failure"], fallback: ["observe_page_state", "runtime_evaluate_js for focused read-only checks", "restart session only after status shows recovery is needed"], avoid_or_stop_rules: ["do not mutate app state while debugging unless approved", "avoid screenshots unless visual layout is the failure"], risk: "medium", cost: "medium", budget: "one targeted debug observation first; expand to page_state only if the failure remains unclear" };
    case "database_read":
      return { ...common, family: "database", recommended_tools: ["pg-mcp", "mariadb"], cheapest_first_action: "list_connections, then list databases/schemas/tables or describe_table before any SELECT", expected_evidence: ["connection/database/schema/table names", "table shape or bounded SELECT rows", "row limit and read-only query text"], fallback: ["inspect migrations/ORM models/fixtures locally", "use EXPLAIN/DESCRIBE for shape", "suggest manual query for unsafe writes"], avoid_or_stop_rules: ["stop before writes, migrations, deletes, updates, or production risk", "keep SELECT row limits small"], risk: "high", cost: "low", budget: "schema inspection first; at most one bounded SELECT per narrow question unless more evidence is required" };
    case "remote_ssh":
      return { ...common, family: "remote_ssh", recommended_tools: ["ssh-mcp"], cheapest_first_action: "ssh-mcp_list_hosts or ssh-mcp_test_connection for the intended configured host", expected_evidence: ["host name", "bounded command and timeout", "compact stdout/stderr or connectivity result"], fallback: ["local repo inspection", "ledger context", "ask for approval/host clarity before remote writes"], avoid_or_stop_rules: ["stop for destructive commands, deployments, production writes, prompts, or missing host clarity", "use non-interactive bounded commands only"], risk: "high", cost: "medium", budget: "connectivity or host listing first; one bounded read-only command when local evidence cannot answer" };
    case "image_generation_or_edit":
      return { ...common, family: "image", recommended_tools: ["image-prompting skill", "openai-image-gen-mcp"], cheapest_first_action: "load image-prompting skill and prepare prompt JSON before generate_image or edit_image", expected_evidence: ["source_prompt_preview", "output path or response id", "input image/previous id for edits when applicable"], fallback: ["written prompt only", "openai-image-gen-mcp_get_auth_status after auth failure", "stop if edit inputs are missing"], avoid_or_stop_rules: ["do not fabricate generated outputs", "do not call edit_image without input_images or previous image ids"], risk: "medium", cost: "high", budget: "one prompt-shaping pass before one generation/edit call; retry only with concrete failure evidence" };
    case "ledger_context":
      return { ...common, family: "ledger_context", recommended_tools: ["orchestrator tools"], cheapest_first_action: "orchestrator_session_current or orchestrator_get_current_task when assigned; otherwise query explicit task/project context", expected_evidence: ["task/mission/project ids", "compact context or artifact refs", "status/evidence fields from ledger"], fallback: ["orchestrator_context_search", "orchestrator_artifact_query", "orchestrator_context_compact for durable handoff"], avoid_or_stop_rules: ["do not publish raw transcripts", "do not claim done without evidence", "avoid duplicating the same data as both artifact and context"], risk: "low", cost: "low", budget: "one current-task/session call first; compact only high-signal reusable context" };
    case "research":
      return { ...common, family: "research", recommended_tools: ["orchestrator_research_route", "context7", "grep_app", "searxng"], cheapest_first_action: "orchestrator_research_route to choose route/query/fallback/budget when external route is unclear", expected_evidence: ["route recommendation", "source URLs/library ids/repository paths after actual research", "uncertainty for unsupported claims"], fallback: ["repo-local Grep/Read when local evidence is enough", "official docs before broad web", "code-shaped grep.app search for real usage"], avoid_or_stop_rules: ["this helper does not replace orchestrator_research_route", "do not use external calls when repo evidence answers the question", "do not present unsupported guesses as facts"], risk: "medium", cost: "medium", budget: "preflight only; use orchestrator_research_route for detailed research call budget" };
    case "local_repo":
      return { ...common, family: "local_repo", recommended_tools: ["Glob", "Grep", "Read", "Bash for safe local checks"], cheapest_first_action: "Glob/Grep/Read repo evidence before Bash or external research", expected_evidence: ["file paths and line references", "local command output when checks are needed", "explicit note when no external call was needed"], fallback: ["orchestrator_context_search", "safe focused local test/typecheck", "orchestrator_research_route only if repo evidence is insufficient and external behavior matters"], avoid_or_stop_rules: ["do not run destructive scripts or interactive commands", "stop before scope-expanding architecture or dependency changes"], risk: "low", cost: "low", budget: "cheap local search first; run the narrowest relevant local check after edits or findings" };
  }
}

const GIT_PATTERNS = ["git read and write commands"];

function guardProjectRoot(ledger: OrchestratorLedger, task?: ReturnType<OrchestratorLedger["getTask"]>, fallbackRoot = process.cwd()): string {
  return task?.project_id ? ledger.getProject(task.project_id)?.root_path ?? fallbackRoot : fallbackRoot;
}

function normalizeGuardPaths(paths: string[] | undefined, input: { projectRoot: string; cwd?: string }): string[] {
  return [...new Set((paths ?? []).filter((path) => path.trim()).map((path) => canonicalLockScope(path, { projectDirectory: input.projectRoot, cwd: input.cwd ?? input.projectRoot })) )];
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function mergeEnvContent(existing: string, values: Record<string, string>): string {
  const keys = new Set(Object.keys(values));
  const lines = existing ? existing.replace(/\n$/, "").split("\n") : [];
  const kept = lines.filter((line) => {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/);
    return !match?.[1] || !keys.has(match[1]);
  });
  for (const key of keys) {
    kept.push(`${key}=${values[key]}`);
  }
  return `${kept.join("\n")}\n`;
}

export function writeSecretEnvFile(input: { projectRoot: string; targetPath: string; values: Record<string, string> }): SecretEnvWriteResult {
  const normalizedPath = canonicalLockScope(input.targetPath, { projectDirectory: input.projectRoot, cwd: input.projectRoot });
  const keys = Object.keys(input.values).sort();
  const valueHashes = Object.fromEntries(keys.map((key) => [key, createHash("sha256").update(input.values[key] ?? "").digest("hex").slice(0, 12)]));
  const blocked = (error: string, blocker: string, evidence: string[] = []): SecretEnvWriteResult => ({
    ok: false,
    status: "blocked",
    target_path: input.targetPath,
    normalized_path: normalizedPath,
    keys,
    value_count: keys.length,
    value_hashes: valueHashes,
    evidence,
    error,
    blocker,
  });

  if (!keys.length) return blocked("empty_values", "No key/value payload was provided; no env file was written.");
  if (!keys.every((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) return blocked("invalid_key", "All env keys must be shell-safe identifiers; no env file was written.");

  const absolutePath = join(input.projectRoot, normalizedPath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  const existing = existsSync(absolutePath) ? readFileSync(absolutePath, "utf8") : "";
  const quotedValues = Object.fromEntries(keys.map((key) => [key, shellQuote(input.values[key] ?? "")]));
  writeFileSync(absolutePath, mergeEnvContent(existing, quotedValues), { mode: 0o600 });
  return { ok: true, status: "written", target_path: input.targetPath, normalized_path: normalizedPath, keys, value_count: keys.length, value_hashes: valueHashes, evidence: ["wrote env file; read the file directly for values"] };
}

export function buildGuardPreflight(input: {
  action: GuardAction;
  paths?: string[];
  command?: string;
  task?: ReturnType<OrchestratorLedger["getTask"]>;
  agent?: string;
  cwd?: string;
  projectRoot?: string;
}): GuardPreflight {
  const projectRoot = input.projectRoot ?? process.cwd();
  const normalizedPaths = normalizeGuardPaths(input.paths, { projectRoot, cwd: input.cwd });
  const base = {
    action: input.action,
    normalized_paths: normalizedPaths,
    required_lock_scope: null,
    retry_policy: "No project-level guard restrictions are applied by this preflight.",
    secret_handling: "Secret values are not returned by the env helper response.",
    caveats: ["Preflight is side-effect-free and advisory.", "It does not run git, inspect file contents, acquire/release locks, or write DB state."],
  };

  if (input.action === "git_read") {
    return { ...base, allowed: true, reason_code: "git_allowed", safe_helper: "Use Bash for git commands.", recovery: "No git command block is applied." };
  }
  if (input.action === "git_write") {
    return { ...base, allowed: true, reason_code: "git_allowed", safe_helper: "Use Bash for git commands.", recovery: "No git mutation or output-write block is applied." };
  }
  if (input.action === "secret_env_write") {
    return { ...base, allowed: true, reason_code: "secret_env_write_allowed", safe_helper: "Use orchestrator_secret_env_write to write secrets to the target file.", recovery: "No ignored/untracked/local-env path block is applied." };
  }
  if (input.action === "unknown_edit" || (input.action === "write" && normalizedPaths.length === 0)) {
    return { ...base, allowed: true, reason_code: "write_allowed", safe_helper: "Use available file tools.", recovery: "No pathless edit block is applied." };
  }
  if (input.action === "lock") {
    return { ...base, allowed: true, reason_code: "lock_allowed", safe_helper: "No file-lock action is required for writer edits.", recovery: "Proceed with the task scope." };
  }

  return { ...base, allowed: true, reason_code: "write_allowed", safe_helper: "Proceed with available file tools.", recovery: "No project-level write guard is applied." };
}

function ownTaskId(
  ledger: OrchestratorLedger,
  explicit: string | null | undefined,
  sessionID: string,
): string | undefined {
  return normalizeOptionalID(explicit) || ledger.getSessionTask(sessionID)?.id;
}

function optId(value: string | null | undefined): string | undefined {
  return normalizeOptionalID(value);
}

function compactTask(task: ReturnType<OrchestratorLedger["getTask"]>) {
  if (!task) return undefined;
  return {
    id: task.id,
    mission_id: task.mission_id,
    project_id: task.project_id,
    parent_task_id: task.parent_task_id,
    backlog_status: task.backlog_status,
    title: task.title,
    type: task.type,
    assigned_agent: task.assigned_agent,
    status: task.status,
    priority: task.priority,
    dependencies: task.dependencies,
    acceptance_criteria: task.acceptance_criteria,
    evidence_requirements: task.evidence_requirements,
    scope: task.scope,
    file_scope: task.file_scope,
    verification: task.verification,
    worker_report: task.worker_report,
    created_at: task.created_at,
    updated_at: task.updated_at,
  };
}

export function createOrchestrationTools(
  ledger: OrchestratorLedger,
  config: HarnessConfig = {},
  projectDirectory = process.cwd(),
): Record<string, ToolDefinition> {
  return {
    orchestrator_sync_status: tool({
      description:
        "Return the side-effect-free ledger sync plan/status for private sync repo workflows. Does not run git or modify the DB.",
      args: {
        phase: ledgerSyncPhaseSchema.optional(),
      },
      async execute(args) {
        return json({
          ok: true,
          sync: buildLedgerSyncPlan(
            projectDirectory,
            config,
            (args.phase ?? "manual") as LedgerSyncPhase,
          ),
        });
      },
    }),

    orchestrator_sync_reconcile_plan: tool({
      description:
        "Compare local and remote ledger row snapshots and return a deterministic side-effect-free merge plan with conflicts. Does not run git or write SQLite.",
      args: {
        local_snapshot: s.record(s.string(), s.array(s.record(s.string(), s.unknown()))),
        remote_snapshot: s.record(s.string(), s.array(s.record(s.string(), s.unknown()))),
      },
      async execute(args) {
        return json(reconcileLedgerSnapshots(args.local_snapshot, args.remote_snapshot));
      },
    }),

    orchestrator_sync_reconcile_files: tool({
      description:
        "Read two SQLite ledger snapshot files read-only, reconcile rows, and optionally write a merged DB only to an explicit distinct output path. Does not run git or overwrite inputs.",
      args: {
        local_db_path: s.string().min(1),
        remote_db_path: s.string().min(1),
        output_db_path: s.string().optional(),
        dry_run: s.boolean().optional(),
      },
      async execute(args) {
        try {
          return json(reconcileLedgerSqliteSnapshots({
            local_db_path: args.local_db_path,
            remote_db_path: args.remote_db_path,
            output_db_path: args.output_db_path,
            dry_run: args.dry_run,
          }));
        } catch (error) {
          return json({ ok: false, error: "sqlite_reconcile_error", message: error instanceof Error ? error.message : String(error) });
        }
      },
    }),

    orchestrator_project_resolve: tool({
      description:
        "Resolve a repository project by id, root/path, or name. Optionally create the project record for attach/resume flows.",
      args: {
        project_id: optionalIDSchema,
        root_path: s.string().optional(),
        path: s.string().optional(),
        name: s.string().optional(),
        project_key: s.string().optional(),
        create: s.boolean().optional(),
        metadata: s.record(s.string(), s.unknown()).optional(),
      },
      async execute(args, context) {
        const rootOrPath = args.root_path ?? args.path;
        const metadata = args.project_key ? { ...(args.metadata ?? {}), project_key: args.project_key } : args.metadata;
        let project = args.project_id ? ledger.getProject(args.project_id) : undefined;
        if (!project && args.project_key) {
          project = ledger.getProjectByKey(args.project_key);
        }
        if (!project && rootOrPath) {
          project = args.create
            ? ledger.getOrCreateProject({ root_path: rootOrPath, name: args.name, metadata })
            : ledger.resolveProject(rootOrPath) ?? ledger.getProjectByRoot(rootOrPath);
        }
        if (!project && args.name && !args.create) {
          project = ledger.getProjectByName(args.name);
        }
        if (!project && args.create) {
          project = ledger.getOrCreateProject({
            root_path: rootOrPath ?? process.cwd(),
            name: args.name,
            metadata,
          });
        }
        if (project && (metadata || args.name) && !args.create) {
          project = ledger.updateProject({ project_id: project.id, name: args.name, project_key: args.project_key, metadata });
        }
        if (project) context.metadata({ title: `project ${project.id}` });
        return json({ ok: Boolean(project), project, error: project ? undefined : "project_not_found" });
      },
    }),

    orchestrator_project_sensitivity_profile: tool({
      description:
        "Read or update a durable project sensitivity profile stored in project metadata for later packet/context rendering.",
      args: {
        project_id: optionalIDSchema,
        root_path: s.string().optional(),
        path: s.string().optional(),
        append_entries: s.array(s.object({
          kind: sensitivityKindSchema.optional(),
          text: s.string().min(1),
          source: sensitivitySourceSchema.optional(),
          precedence: s.number().optional(),
          scope: s.string().optional(),
          risk: sensitivityRiskSchema.optional(),
          expires_at: s.string().optional(),
          supersedes: s.array(s.string()).optional(),
          active: s.boolean().optional(),
        })).optional(),
      },
      async execute(args, context) {
        const rootOrPath = args.root_path ?? args.path;
        const project = args.project_id
          ? ledger.getProject(args.project_id)
          : rootOrPath
            ? ledger.resolveProject(rootOrPath) ?? ledger.getProjectByRoot(rootOrPath)
            : undefined;
        if (!project) return json({ ok: false, error: "project_not_found" });
        const appendEntries = args.append_entries as
          | Array<{
              kind?: ProjectSensitivityProfileEntryKind;
              text: string;
              source?: ProjectSensitivityProfileSource;
              precedence?: number;
              scope?: string;
              risk?: "security" | "data_loss" | "external_write" | "auth_state" | "git_history" | "custom";
              expires_at?: string;
              supersedes?: string[];
              active?: boolean;
            }>
          | undefined;
        const profile = appendEntries?.length
          ? ledger.updateProjectSensitivityProfile({ project_id: project.id, append_entries: appendEntries })
          : ledger.getProjectSensitivityProfile(project.id);
        context.metadata({ title: `project ${project.id} sensitivity profile` });
        return json({ ok: true, project_id: project.id, profile: profile ?? null });
      },
    }),

    orchestrator_project_status: tool({
      description:
        "Return a compact project snapshot with recent sessions, active/recent tasks, and related gate state.",
      args: {
        project_id: optionalIDSchema,
        root_path: s.string().optional(),
        limit: s.number().int().min(1).max(25).optional(),
      },
      async execute(args) {
        const project = args.project_id
          ? ledger.getProject(args.project_id)
          : args.root_path
            ? ledger.resolveProject(args.root_path) ?? ledger.getProjectByRoot(args.root_path)
            : undefined;
        if (!project) return json({ ok: false, error: "project_not_found" });
        const tasks = ledger.listProjectTasks({ project_id: project.id }).slice(0, args.limit ?? 25);
        const sessions = ledger.listProjectSessions({ project_id: project.id, limit: args.limit });
        const activeMissionIDs = [...new Set(tasks.map((task) => task.mission_id).filter((id): id is string => Boolean(id)))];
        return json({
          ok: true,
          project,
          sessions: sessions.map((session) => ({
            id: session.id,
            opencode_session_id: session.opencode_session_id,
            active_mission_id: session.active_mission_id,
            active_task_id: session.active_task_id,
            agent: session.agent,
            status: session.status,
            updated_at: session.updated_at,
          })),
          tasks: tasks.map(compactTask),
          gates: activeMissionIDs.map((missionID) => ledger.checkGate(missionID)),
        });
      },
    }),

    orchestrator_flight_deck_report: tool({
      description:
        "Return a read-only mission/project flight deck with task lanes, acceptance coverage, gate state, and next safest action.",
      args: {
        mission_id: optionalIDSchema.describe("Mission id. Defaults to active mission when project_id is omitted."),
        project_id: optionalIDSchema.describe("Project id for a project-wide backlog/mission task report."),
        limit: s.number().int().min(1).max(25).optional().describe("Maximum tasks per lane."),
      },
      async execute(args) {
        try {
          const report = ledger.buildFlightDeckReport({
            mission_id: optId(args.mission_id),
            project_id: optId(args.project_id),
            limit: args.limit,
          });
          return json(report ?? { ok: false, error: "flight_deck_scope_not_found" });
        } catch (error) {
          return errorJson(error);
        }
      },
    }),

    orchestrator_session_attach: tool({
      description:
        "Attach or update the current OpenCode session to a project, mission, task, agent, cwd, and optional parent session.",
      args: {
        session_id: optionalIDSchema.describe("OpenCode session id. Defaults to current session."),
        project_id: optionalIDSchema,
        root_path: s.string().optional(),
        active_mission_id: optionalIDSchema,
        active_task_id: optionalIDSchema,
        agent: s.string().optional(),
        cwd: s.string().optional(),
        parent_session_id: optionalIDSchema,
        status: sessionStatusSchema.optional(),
        metadata: s.record(s.string(), s.unknown()).optional(),
      },
      async execute(args, context) {
        try {
        const activeTaskID = optId(args.active_task_id);
        const projectID = optId(args.project_id);
        const task = activeTaskID ? ledger.getTask(activeTaskID) : undefined;
        const project = projectID
          ? ledger.getProject(projectID)
          : task?.project_id
            ? ledger.getProject(task.project_id)
            : args.root_path
              ? ledger.getOrCreateProject({ root_path: args.root_path })
              : undefined;
        const session = ledger.attachSession({
          opencode_session_id: optId(args.session_id) ?? context.sessionID,
          project_id: project?.id,
          cwd: args.cwd ?? args.root_path ?? project?.root_path ?? process.cwd(),
          active_mission_id: optId(args.active_mission_id) ?? task?.mission_id,
          active_task_id: activeTaskID,
          agent: args.agent ?? context.agent,
          parent_session_id: optId(args.parent_session_id),
          status: args.status as SessionStatus | undefined,
          metadata: args.metadata,
        });
        return json({ ok: true, session, project, task: compactTask(task) });
        } catch (error) {
          return errorJson(error);
        }
      },
    }),

    orchestrator_session_current: tool({
      description:
        "Load the current session's project, mission, task, dependencies, and compact context/artifact references.",
      args: {
        session_id: optionalIDSchema.describe("OpenCode session id. Defaults to current session."),
        context_limit: s.number().int().min(1).max(25).optional(),
      },
      async execute(args, context) {
        const session = ledger.getSession(optId(args.session_id) ?? context.sessionID);
        if (!session) return json({ ok: false, error: "session_not_found" });
        const task = session.active_task_id ? ledger.getTask(session.active_task_id) : undefined;
        const mission = session.active_mission_id ? ledger.getMission(session.active_mission_id) : undefined;
        const project = session.project_id ? ledger.getProject(session.project_id) : undefined;
        return json({
          ok: true,
          session,
          project,
          mission,
          task: compactTask(task),
          dependencies: (task?.dependencies ?? []).map((id) => compactTask(ledger.getTask(id))).filter(Boolean),
          context: ledger.searchContext({
            project_id: project?.id,
            mission_id: mission?.id,
            task_id: task?.id,
            limit: args.context_limit,
          }),
        });
      },
    }),

    orchestrator_get_current_task: tool({
      description:
        "Return the linked current task by session id or explicit task id, including dependencies and compact context references.",
      args: {
        session_id: optionalIDSchema,
        task_id: optionalIDSchema,
        context_limit: s.number().int().min(1).max(25).optional(),
      },
      async execute(args, context) {
        const taskID = optId(args.task_id) ?? ledger.getSessionTask(optId(args.session_id) ?? context.sessionID)?.id;
        if (!taskID) return json({ ok: false, error: "missing_task_id" });
        const task = ledger.getTask(taskID);
        if (!task) return json({ ok: false, error: "task_not_found" });
        return json({
          ok: true,
          task: compactTask(task),
          dependencies: task.dependencies.map((id) => compactTask(ledger.getTask(id))).filter(Boolean),
          context: ledger.searchContext({
            project_id: task.project_id,
            mission_id: task.mission_id,
            task_id: task.id,
            limit: args.context_limit,
          }),
        });
      },
    }),

    orchestrator_project_tasks: tool({
      description:
        "List or search project tasks/backlog by project, status, assigned agent, parent task, backlog status, and text query.",
      args: {
        project_id: s.string(),
        backlog_status: backlogStatusSchema.optional(),
        parent_task_id: optionalIDSchema,
        status: taskStatusSchema.optional(),
        assigned_agent: workerAgentSchema.optional(),
        query: s.string().optional(),
        limit: s.number().int().min(1).max(50).optional(),
      },
      async execute(args) {
        try {
        const query = args.query?.trim().toLowerCase();
        const tasks = ledger
          .listProjectTasks({
            project_id: args.project_id,
            backlog_status: args.backlog_status as BacklogStatus | undefined,
            parent_task_id: optId(args.parent_task_id),
          })
          .filter((task) => !args.status || task.status === args.status)
          .filter((task) => !args.assigned_agent || task.assigned_agent === args.assigned_agent)
          .filter((task) => !query || `${task.id} ${task.title} ${task.scope}`.toLowerCase().includes(query))
          .slice(0, args.limit ?? 50);
        return json({ ok: true, tasks: tasks.map(compactTask) });
        } catch (error) {
          return errorJson(error);
        }
      },
    }),

    orchestrator_context_search: tool({
      description:
        "Search compact context bundles and artifacts by project, mission, task, tags, and text query without exposing raw transcripts.",
      args: {
        project_id: optionalIDSchema,
        mission_id: optionalIDSchema,
        task_id: optionalIDSchema,
        tags: s.array(s.string()).optional(),
        query: s.string().optional(),
        include_artifacts: s.boolean().optional(),
        include_bundles: s.boolean().optional(),
        limit: s.number().int().min(1).max(25).optional(),
      },
      async execute(args, context) {
        try {
        return json({
          ok: true,
          results: ledger.searchContext({
            project_id: optId(args.project_id),
            mission_id: optId(args.mission_id),
            task_id: ownTaskId(ledger, args.task_id, context.sessionID),
            tags: args.tags,
            query: args.query,
            include_artifacts: args.include_artifacts,
            include_bundles: args.include_bundles,
            limit: args.limit,
          }),
        });
        } catch (error) {
          return errorJson(error);
        }
      },
    }),

    orchestrator_research_route: tool({
      description:
        "Recommend a compact research route across Context7, grep.app, SearXNG, URL read, or no external call without making external calls.",
      args: {
        intent: researchIntentSchema.optional().describe(
          "official_docs | real_world_code | current_web | known_url | repo_local | broad_research. If omitted, intent is inferred from query/url.",
        ),
        query: s.string().optional().describe("Natural-language question, code/API target, or search seed to rewrite."),
        url: s.string().optional().describe("Known URL to read directly when intent is known_url."),
        repo_local: s.boolean().optional().describe("Force no-external-call routing when the answer should come from repo evidence."),
      },
      async execute(args) {
        return json({ ok: true, route: buildResearchRoute(args as Parameters<typeof buildResearchRoute>[0]) });
      },
    }),

    orchestrator_tool_preflight: tool({
      description:
        "Recommend the cheapest side-effect-free MCP/tool preflight for a tool intent without calling external tools or mutating ledger state.",
      args: {
        intent: toolPreflightIntentSchema.describe(
          "browser_interaction | browser_debug | database_read | remote_ssh | image_generation_or_edit | ledger_context | research | local_repo",
        ),
      },
      async execute(args) {
        return json({ ok: true, preflight: buildToolPreflight(args as Parameters<typeof buildToolPreflight>[0]) });
      },
    }),

    orchestrator_guard_manifest: tool({
      description:
        "Return a compact runtime-generated guard/architecture manifest for the current worker/session. Side-effect-free and read-only.",
      args: {
        task_id: optionalIDSchema,
        session_id: optionalIDSchema,
      },
      async execute(args, context) {
        const taskID = optId(args.task_id) ?? ledger.getSessionTask(optId(args.session_id) ?? context.sessionID)?.id;
        const task = taskID ? ledger.getTask(taskID) : undefined;
        const projectRoot = guardProjectRoot(ledger, task, projectDirectory);
        const session = ledger.getSession(optId(args.session_id) ?? context.sessionID);
        const missionID = task?.mission_id ?? session?.active_mission_id;
        return json({
          ok: true,
          manifest: {
            project_root: projectRoot,
            cwd: session?.cwd ?? projectDirectory,
            task_id: task?.id ?? null,
            file_scope: task?.file_scope ?? [],
            active_locks: [],
            git_patterns: GIT_PATTERNS,
            blocked_git_mutations: [],
            secret_write_policy: "Project-level secret write blocks are disabled. Agents may write secrets to files and use them directly.",
            retry_stop_policy: "No project-level guard retry-stop policy is applied.",
            intended_flow: "inspect → act → verify → report",
          },
        });
      },
    }),

    orchestrator_guard_preflight: tool({
      description:
        "Side-effect-free guard preflight for proposed write/git/secret/lock actions. Does not mutate git, files, locks, or DB state.",
      args: {
        action: guardActionSchema,
        paths: s.array(s.string()).optional(),
        command: s.string().optional(),
        task_id: optionalIDSchema,
        session_id: optionalIDSchema,
        cwd: s.string().optional(),
      },
      async execute(args, context) {
        const taskID = optId(args.task_id) ?? ledger.getSessionTask(optId(args.session_id) ?? context.sessionID)?.id;
        const task = taskID ? ledger.getTask(taskID) : undefined;
        const session = ledger.getSession(optId(args.session_id) ?? context.sessionID);
        const projectRoot = guardProjectRoot(ledger, task, projectDirectory);
        return json({
          ok: true,
          preflight: buildGuardPreflight({
            action: args.action as GuardAction,
            paths: args.paths,
            command: args.command,
            task,
            agent: context.agent,
            cwd: args.cwd ?? session?.cwd ?? projectDirectory,
            projectRoot,
          }),
        });
      },
    }),

    orchestrator_secret_env_write: tool({
      description:
        "Helper for writing env credentials. Writes key=value pairs to the target file; agents read the file directly for values.",
      args: {
        target_path: s.string().min(1).describe("Approved local env target, for example .env.local or .env.test.local."),
        values: s.record(s.string(), s.string()).describe("Task-scoped key/value payload written to the target file."),
        task_id: optionalIDSchema,
        session_id: optionalIDSchema,
      },
      async execute(args, context) {
        const taskID = optId(args.task_id) ?? ledger.getSessionTask(optId(args.session_id) ?? context.sessionID)?.id;
        const task = taskID ? ledger.getTask(taskID) : undefined;
        const session = ledger.getSession(optId(args.session_id) ?? context.sessionID);
        const projectRoot = guardProjectRoot(ledger, task, projectDirectory);
        const normalizedPath = canonicalLockScope(args.target_path, { projectDirectory: projectRoot, cwd: session?.cwd ?? projectRoot });
        return json(writeSecretEnvFile({ projectRoot, targetPath: normalizedPath, values: args.values }));
      },
    }),

    orchestrator_context_compact: tool({
      description:
        "Compact selected project/mission/task context and artifacts into a durable context bundle for later agents.",
      args: {
        project_id: optionalIDSchema,
        mission_id: optionalIDSchema,
        task_id: optionalIDSchema,
        title: s.string().min(1),
        source_query: s.string().optional(),
        source_tags: s.array(s.string()).optional(),
        max_items: s.number().int().min(1).max(25).optional(),
        tags: s.array(s.string()).optional(),
      },
      async execute(args, context) {
        try {
        const taskID = ownTaskId(ledger, args.task_id, context.sessionID);
        const task = taskID ? ledger.getTask(taskID) : undefined;
        const results = ledger.searchContext({
          project_id: optId(args.project_id) ?? task?.project_id,
          mission_id: optId(args.mission_id) ?? task?.mission_id,
          task_id: taskID,
          tags: args.source_tags,
          query: args.source_query,
          limit: args.max_items,
        });
        const content = results.length
          ? results.map((item) => `[${item.source}:${item.id}] ${item.title}\n${item.content}`).join("\n\n")
          : "No matching context sources found; compact bundle records an empty source set.";
        const bundle = ledger.publishContextBundle({
          project_id: optId(args.project_id) ?? task?.project_id,
          mission_id: optId(args.mission_id) ?? task?.mission_id,
          task_id: taskID,
          title: args.title,
          content,
          tags: args.tags ?? ["compact"],
          created_by: context.agent,
        });
        return json({ ok: true, context_bundle_id: bundle.id, source_count: results.length, sources: results });
        } catch (error) {
          return errorJson(error);
        }
      },
    }),

    orchestrator_mission_create: tool({
      description:
        "Create a durable Mission Control mission in the SQLite orchestration ledger. Call this before decomposing or delegating mission work.",
      args: {
        title: s.string().min(1).describe("Short mission title."),
        goal: s.string().min(1).describe("Full user goal and success condition."),
        metadata: s
          .record(s.string(), s.unknown())
          .optional()
          .describe("Optional compact mission metadata."),
      },
      async execute(args, context) {
        const mission = ledger.createMission({
          title: args.title,
          goal: args.goal,
          metadata: args.metadata,
          sessionID: context.sessionID,
          agent: context.agent,
        });
        context.metadata({ title: `mission ${mission.id}` });
        return json({ ok: true, mission });
      },
    }),

    orchestrator_mission_status: tool({
      description:
        "Return a compact mission snapshot from the durable orchestration ledger, including task counts, blockers, and gate state.",
      args: {
        mission_id: optionalIDSchema.describe("Mission id. Defaults to active mission."),
      },
      async execute(args, context) {
        const missionID = optId(args.mission_id);
        const mission = missionID
          ? ledger.getMission(missionID)
          : ledger.getActiveMission();
        if (!mission) return json({ ok: false, error: "no_active_mission" });
        ledger.linkSession(context.sessionID, mission.id, undefined, context.agent);
        return json({
          ok: true,
          mission,
          tasks: ledger.listTasks(mission.id).map((task) => ({
            id: task.id,
            title: task.title,
            status: task.status,
            assigned_agent: task.assigned_agent,
            priority: task.priority,
          })),
          gate: ledger.checkGate(mission.id),
        });
      },
    }),

    orchestrator_task_create: tool({
      description:
        "Create a dependency-aware ledger task with agent assignment, scope, acceptance criteria, and evidence requirements.",
      args: {
        mission_id: optionalIDSchema.describe("Mission id. Defaults to active mission."),
        project_id: optionalIDSchema.describe("Optional project id for project/backlog task tracking."),
        parent_task_id: optionalIDSchema.describe("Optional parent task id for subtasks."),
        backlog_status: backlogStatusSchema.optional(),
        title: s.string().min(1),
        type: taskTypeSchema,
        assigned_agent: workerAgentSchema,
        priority: taskPrioritySchema.optional(),
        dependencies: s.array(s.string()).optional(),
        acceptance_criteria: s.array(criterionSchema.or(s.string())).optional(),
        evidence_requirements: s.array(s.string()).optional(),
        scope: s.string().min(1).describe("Task scope summary."),
        file_scope: s
          .array(s.string())
          .optional()
          .describe("Files, directories, or globs this task may edit or inspect."),
        status: taskStatusSchema.optional(),
      },
      async execute(args) {
        try {
        const task = ledger.createTask({
          mission_id: optId(args.mission_id),
          project_id: optId(args.project_id),
          parent_task_id: optId(args.parent_task_id),
          backlog_status: args.backlog_status as BacklogStatus | undefined,
          title: args.title,
          type: args.type as TaskType,
          assigned_agent: args.assigned_agent,
          priority: args.priority as TaskPriority | undefined,
          dependencies: args.dependencies,
          acceptance_criteria: args.acceptance_criteria as Array<string | AcceptanceCriterion> | undefined,
          evidence_requirements: args.evidence_requirements,
          scope: args.scope,
          file_scope: args.file_scope,
          status: args.status as TaskStatus | undefined,
        });
        return json({ ok: true, task });
        } catch (error) {
          return errorJson(error);
        }
      },
    }),

    orchestrator_task_update: tool({
      description:
        "Update task status, structured worker report, criterion evidence, and verification data. Done claims without evidence are downgraded to needs_verification.",
      args: {
        task_id: optionalIDSchema.describe("Ledger task id. Defaults to linked session task when available."),
        status: taskStatusSchema.optional(),
        summary: s.string().optional(),
        acceptance_criteria: s.array(criterionSchema).optional(),
        verification: verificationSchema.optional(),
        files_changed: s
          .array(
            s.object({
              path: s.string(),
              change: s.string(),
            }),
          )
          .optional(),
        artifacts: s
          .array(
            s.object({
              type: s.string(),
              title: s.string(),
              content: s.string(),
            }),
          )
          .optional(),
        blockers: s.array(s.string()).optional(),
        remaining_gaps: s.array(s.string()).optional(),
        confidence: s.enum(["low", "medium", "high"]).optional(),
      },
      async execute(args, context) {
        try {
        const taskID = ownTaskId(ledger, args.task_id, context.sessionID);
        if (!taskID) return json({ ok: false, error: "missing_task_id" });
        const workerReport: Record<string, unknown> = {
          ...(args.files_changed ? { files_changed: args.files_changed } : {}),
          ...(args.artifacts ? { artifacts: args.artifacts } : {}),
          ...(args.blockers ? { blockers: args.blockers } : {}),
          ...(args.confidence ? { confidence: args.confidence } : {}),
          updated_by: context.agent,
        };
        const result = ledger.updateTask({
          task_id: taskID,
          status: args.status as TaskStatus | undefined,
          summary: args.summary,
          acceptance_criteria: args.acceptance_criteria as AcceptanceCriterion[] | undefined,
          verification: args.verification as TaskVerification | undefined,
          worker_report: workerReport,
          remaining_gaps: args.remaining_gaps,
        });
        for (const artifact of args.artifacts ?? []) {
          ledger.publishArtifact({
            task_id: taskID,
            type: artifact.type,
            title: artifact.title,
            content: artifact.content,
            created_by: context.agent,
          });
        }
        return json({ ok: true, ...result });
        } catch (error) {
          return errorJson(error);
        }
      },
    }),

    orchestrator_task_reopen: tool({
      description:
        "Reopen a task when evidence is missing, verifier issues remain, or a worker report is incomplete.",
      args: {
        task_id: s.string(),
        reason: s.string().min(1),
      },
      async execute(args, context) {
        const task = ledger.reopenTask({
          task_id: args.task_id,
          reason: args.reason,
          created_by: context.agent,
        });
        return json({ ok: true, task });
      },
    }),

    orchestrator_artifact_publish: tool({
      description:
        "Publish compact evidence or output artifacts to the ledger without sharing raw worker transcripts.",
      args: {
        mission_id: optionalIDSchema,
        project_id: optionalIDSchema,
        task_id: optionalIDSchema,
        type: s.string().min(1),
        title: s.string().min(1),
        content: s.string().min(1),
      },
      async execute(args, context) {
        try {
        const id = ledger.publishArtifact({
          mission_id: optId(args.mission_id),
          project_id: optId(args.project_id),
          task_id: ownTaskId(ledger, args.task_id, context.sessionID),
          type: args.type,
          title: args.title,
          content: args.content,
          created_by: context.agent,
        }).id;
        return json({ ok: true, artifact_id: id });
        } catch (error) {
          return errorJson(error);
        }
      },
    }),

    orchestrator_artifact_query: tool({
      description:
        "Query compact ledger artifacts by mission, task, and optional artifact type. Does not expose raw transcripts.",
      args: {
        mission_id: optionalIDSchema,
        project_id: optionalIDSchema,
        task_id: optionalIDSchema,
        type: s.string().optional(),
        limit: s.number().int().min(1).max(25).optional(),
      },
      async execute(args, context) {
        try {
        return json({
          ok: true,
          artifacts: ledger.queryArtifacts({
            mission_id: optId(args.mission_id),
            project_id: optId(args.project_id),
            task_id: ownTaskId(ledger, args.task_id, context.sessionID),
            type: args.type,
            limit: args.limit,
          }),
        });
        } catch (error) {
          return errorJson(error);
        }
      },
    }),

    orchestrator_context_publish: tool({
      description:
        "Publish a curated high-signal context bundle to the ledger for downstream agents.",
      args: {
        mission_id: optionalIDSchema,
        project_id: optionalIDSchema,
        task_id: optionalIDSchema,
        title: s.string().min(1),
        content: s.string().min(1),
        tags: s.array(s.string()).optional(),
      },
      async execute(args, context) {
        try {
        const id = ledger.publishContextBundle({
          mission_id: optId(args.mission_id),
          project_id: optId(args.project_id),
          task_id: ownTaskId(ledger, args.task_id, context.sessionID),
          title: args.title,
          content: args.content,
          tags: args.tags,
          created_by: context.agent,
        }).id;
        return json({ ok: true, context_bundle_id: id });
        } catch (error) {
          return errorJson(error);
        }
      },
    }),

    orchestrator_context_query: tool({
      description:
        "Query curated ledger context bundles by mission, task, or tags. Does not expose raw transcripts.",
      args: {
        mission_id: optionalIDSchema,
        project_id: optionalIDSchema,
        task_id: optionalIDSchema,
        tags: s.array(s.string()).optional(),
        limit: s.number().int().min(1).max(25).optional(),
      },
      async execute(args, context) {
        try {
        return json({
          ok: true,
          bundles: ledger.queryContextBundles({
            mission_id: optId(args.mission_id),
            project_id: optId(args.project_id),
            task_id: ownTaskId(ledger, args.task_id, context.sessionID),
            tags: args.tags,
            limit: args.limit,
          }),
        });
        } catch (error) {
          return errorJson(error);
        }
      },
    }),

    orchestrator_decision_record: tool({
      description:
        "Record a durable Mission Control decision so compaction and later workers preserve the why.",
      args: {
        mission_id: optionalIDSchema,
        task_id: optionalIDSchema,
        title: s.string().min(1),
        content: s.string().min(1),
      },
      async execute(args, context) {
        const id = ledger.recordDecision({
          mission_id: optId(args.mission_id),
          task_id: ownTaskId(ledger, args.task_id, context.sessionID),
          title: args.title,
          content: args.content,
          created_by: context.agent,
        }).id;
        return json({ ok: true, decision_id: id });
      },
    }),

    orchestrator_blocker_create: tool({
      description:
        "Create a durable blocker. Continue safe independent work first, then Mission Control batches remaining blockers for the user.",
      args: {
        mission_id: optionalIDSchema,
        task_id: optionalIDSchema,
        severity: s.enum(["low", "medium", "high", "critical"]),
        title: s.string().min(1),
        description: s.string().min(1),
        required_user_input: s.boolean(),
      },
      async execute(args, context) {
        const id = ledger.createBlocker({
          mission_id: optId(args.mission_id),
          task_id: ownTaskId(ledger, args.task_id, context.sessionID),
          severity: args.severity,
          title: args.title,
          description: args.description,
          required_user_input: args.required_user_input,
          created_by: context.agent,
        }).id;
        return json({ ok: true, blocker_id: id });
      },
    }),

    orchestrator_blocker_resolve: tool({
      description:
        "Resolve a durable blocker after the required user approval/input or safe unblock evidence is available.",
      args: {
        blocker_id: s.string().min(1),
        resolution: s.string().min(1),
      },
      async execute(args, context) {
        return json({
          ok: true,
          ...ledger.resolveBlocker({
            blocker_id: args.blocker_id,
            resolution: args.resolution,
            resolved_by: context.agent,
          }),
        });
      },
    }),

    orchestrator_verification_record: tool({
      description:
        "Persist a verification-engineer gate report and reopen tasks when the verifier requests changes.",
      args: {
        mission_id: optionalIDSchema,
        task_id: optionalIDSchema,
        verdict: s.enum(["approve", "request-changes"]),
        gate_status: s.enum(["pass", "fail"]),
        checked_criteria: s.array(s.unknown()).optional(),
        issues: s.array(s.unknown()).optional(),
        checks_run: s.array(s.string()).optional(),
        unverified_claims: s.array(s.string()).optional(),
        tasks_to_reopen: s.array(s.string()).optional(),
      },
      async execute(args, context) {
        const id = ledger.recordVerification({
          mission_id: optId(args.mission_id),
          task_id: ownTaskId(ledger, args.task_id, context.sessionID),
          verdict: args.verdict,
          gate_status: args.gate_status,
          report: {
            checked_criteria: args.checked_criteria ?? [],
            issues: args.issues ?? [],
            checks_run: args.checks_run ?? [],
            unverified_claims: args.unverified_claims ?? [],
            tasks_to_reopen: args.tasks_to_reopen ?? [],
          },
          created_by: context.agent,
        }).id;
        return json({ ok: true, verification_id: id });
      },
    }),

    orchestrator_gate_check: tool({
      description:
        "Check the final acceptance gate. Mission Control must call this before final success and obey can_final_success=false.",
      args: {
        mission_id: optionalIDSchema.describe("Mission id. Defaults to active mission."),
      },
      async execute(args) {
        return json({ ok: true, gate: ledger.checkGate(optId(args.mission_id)) });
      },
    }),
  };
}
