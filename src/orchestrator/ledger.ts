import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, hostname, platform } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Database } from "bun:sqlite";
import type { HarnessConfig } from "../types";
import { WORKER_AGENT_SET, type WorkerAgent } from "./constants";

export const DEFAULT_LEDGER_FILENAME = "orchestrator.sqlite";
export const DEFAULT_PROJECT_MARKER_RELATIVE_PATH = ".opencode/orch.txt";

export type MissionStatus = "active" | "blocked" | "done" | "cancelled";
export type TaskStatus =
  | "pending"
  | "in_progress"
  | "blocked"
  | "needs_verification"
  | "reopened"
  | "done"
  | "cancelled";
export type TaskPriority = "low" | "medium" | "high" | "critical";
export type TaskType =
  | "implementation"
  | "frontend"
  | "repo_scout"
  | "research"
  | "verification"
  | "docs"
  | "other";

export type VerificationMode = "real" | "sandbox" | "local" | "mock" | "not_run";
export type VerificationResult = "pass" | "fail" | "partial" | "blocked";
export type SessionStatus = "active" | "idle" | "ended" | "crashed";
export type BacklogStatus = "none" | "backlog" | "ready" | "planned";
export type ContextSourceType = "context_bundle" | "artifact";

export type AcceptanceCriterion = {
  criterion: string;
  met?: boolean;
  evidence?: string;
  verification_type?: string;
};

export type TaskVerification = {
  mode?: VerificationMode;
  commands_or_actions?: string[];
  result?: VerificationResult;
  why_not_real?: string | null;
  low_risk_exception?: string | null;
};

export type MissionRecord = {
  id: string;
  title: string;
  goal: string;
  status: MissionStatus;
  created_at: string;
  updated_at: string;
  metadata: Record<string, unknown>;
};

export type ProjectRecord = {
  id: string;
  name: string;
  root_path: string;
  project_key?: string;
  status: "active" | "archived";
  created_at: string;
  updated_at: string;
  metadata: Record<string, unknown>;
};

export type ProjectSensitivityProfileSource = "repo_detected" | "user" | "mission" | "config" | "tool";
export type ProjectSensitivityProfileEntryKind = "hard_constraint" | "preference" | "tool_policy" | "risk_flag" | "repo_note";

export type ProjectSensitivityProfileEntry = {
  id: string;
  kind: ProjectSensitivityProfileEntryKind;
  text: string;
  source: ProjectSensitivityProfileSource;
  precedence: number;
  created_at: string;
  updated_at: string;
  expires_at?: string;
  supersedes?: string[];
  active?: boolean;
  scope?: string;
  risk?: "security" | "data_loss" | "external_write" | "auth_state" | "git_history" | "custom";
};

export type ProjectSensitivityProfile = {
  schema_version: 1;
  updated_at: string;
  entries: ProjectSensitivityProfileEntry[];
};

export type SessionRecord = {
  id: string;
  opencode_session_id: string;
  project_id?: string;
  cwd: string;
  machine_id: string;
  active_mission_id?: string;
  active_task_id?: string;
  agent?: string;
  parent_session_id?: string;
  status: SessionStatus;
  started_at: string;
  updated_at: string;
  ended_at?: string;
  metadata: Record<string, unknown>;
};

export type TaskRecord = {
  id: string;
  mission_id?: string;
  project_id?: string;
  parent_task_id?: string;
  backlog_status: BacklogStatus;
  title: string;
  type: TaskType;
  assigned_agent: WorkerAgent;
  status: TaskStatus;
  priority: TaskPriority;
  dependencies: string[];
  acceptance_criteria: AcceptanceCriterion[];
  evidence_requirements: string[];
  scope: string;
  file_scope: string[];
  verification: TaskVerification;
  worker_report: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type GateStatus = "pass" | "fail" | "blocked";

export type GateCheckResult = {
  mission_id?: string;
  gate_status: GateStatus;
  can_final_success: boolean;
  can_checkpoint_blockers: boolean;
  open_tasks: Array<Pick<TaskRecord, "id" | "title" | "status" | "assigned_agent">>;
  unresolved_blockers: Array<{
    id: string;
    task_id?: string;
    severity: string;
    title: string;
    required_user_input: boolean;
  }>;
  missing_evidence: Array<{ task_id: string; criterion?: string; reason: string }>;
  verification_issues: Array<{ task_id?: string; issue: string }>;
  next_required_actions: string[];
};

export type AcceptanceCoverageBucket = "unmet" | "claimed" | "evidenced" | "verified";

export type FlightDeckLaneName =
  | "ready"
  | "blocked"
  | "needs_verification"
  | "in_progress"
  | "done"
  | "other";

export type FlightDeckTaskSummary = Pick<
  TaskRecord,
  "id" | "title" | "status" | "assigned_agent" | "priority"
> & {
  dependencies: string[];
  acceptance: Record<AcceptanceCoverageBucket, number>;
};

export type FlightDeckReport = {
  ok: true;
  scope: "mission" | "project";
  mission?: MissionRecord;
  project?: ProjectRecord;
  generated_at: string;
  task_counts: Record<string, number>;
  lanes: Record<FlightDeckLaneName, FlightDeckTaskSummary[]>;
  acceptance_coverage: Record<AcceptanceCoverageBucket, number> & { total: number };
  gate?: GateCheckResult;
  next_safest_action: string;
};

type SqlRow = Record<string, unknown>;

const CURRENT_LEDGER_SCHEMA_VERSION = 2;
const REQUIRED_LEDGER_COLUMNS = {
  tasks: ["project_id", "parent_task_id", "backlog_status"],
  artifacts: ["project_id"],
  context_bundles: ["project_id"],
  projects: ["project_key"],
  sessions: ["project_id", "machine_id"],
  file_locks: ["machine_id"],
} as const;

function now(): string {
  return new Date().toISOString();
}

function encodeJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function decodeJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.trim().length === 0) {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function asProjectSensitivityProfile(value: unknown): ProjectSensitivityProfile | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as { schema_version?: unknown; updated_at?: unknown; entries?: unknown };
  if (candidate.schema_version !== 1 || !Array.isArray(candidate.entries)) return undefined;
  const entries = candidate.entries
    .map((entry): ProjectSensitivityProfileEntry | undefined => {
      if (!entry || typeof entry !== "object") return undefined;
      const item = entry as Record<string, unknown>;
      if (typeof item.id !== "string" || typeof item.text !== "string") return undefined;
      const kind = typeof item.kind === "string" ? item.kind : "repo_note";
      const source = typeof item.source === "string" ? item.source : "repo_detected";
      return {
        id: item.id,
        kind: ["hard_constraint", "preference", "tool_policy", "risk_flag", "repo_note"].includes(kind)
          ? (kind as ProjectSensitivityProfileEntryKind)
          : "repo_note",
        text: item.text,
        source: ["repo_detected", "user", "mission", "config", "tool"].includes(source)
          ? (source as ProjectSensitivityProfileSource)
          : "repo_detected",
        precedence: typeof item.precedence === "number" ? item.precedence : 0,
        created_at: typeof item.created_at === "string" ? item.created_at : now(),
        updated_at: typeof item.updated_at === "string" ? item.updated_at : now(),
        expires_at: typeof item.expires_at === "string" ? item.expires_at : undefined,
        supersedes: asStringArray(item.supersedes),
        active: typeof item.active === "boolean" ? item.active : true,
        scope: typeof item.scope === "string" ? item.scope : undefined,
        risk: typeof item.risk === "string" ? (item.risk as ProjectSensitivityProfileEntry["risk"]) : undefined,
      };
    })
    .filter((entry): entry is ProjectSensitivityProfileEntry => Boolean(entry));
  return {
    schema_version: 1,
    updated_at: typeof candidate.updated_at === "string" ? candidate.updated_at : now(),
    entries,
  };
}

function makeProjectSensitivityEntry(
  input: Omit<Partial<ProjectSensitivityProfileEntry>, "id" | "created_at" | "updated_at"> & { text: string },
  timestamp: string,
): ProjectSensitivityProfileEntry {
  const stableSeed = `${input.kind ?? "repo_note"}:${input.source ?? "repo_detected"}:${input.text}:${input.scope ?? ""}`;
  return {
    id: typeof input.supersedes?.[0] === "string" ? `${input.supersedes[0]}-next` : `psp-${createHash("sha1").update(stableSeed).digest("hex").slice(0, 12)}`,
    kind: input.kind ?? "repo_note",
    text: input.text,
    source: input.source ?? "repo_detected",
    precedence: input.precedence ?? 0,
    created_at: timestamp,
    updated_at: timestamp,
    expires_at: input.expires_at,
    supersedes: input.supersedes,
    active: input.active ?? true,
    scope: input.scope,
    risk: input.risk,
  };
}

function compactText(value: string, max = 220): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function packetText(value: string, max = 220): string {
  return compactText(value, max);
}

function isActiveProjectProfileEntry(entry: ProjectSensitivityProfileEntry, at = new Date()): boolean {
  if (entry.active === false) return false;
  if (!entry.expires_at) return true;
  const expiresAt = Date.parse(entry.expires_at);
  return Number.isNaN(expiresAt) || expiresAt > at.getTime();
}

function renderProjectSensitivityProfile(profile?: ProjectSensitivityProfile): string {
  const entries = (profile?.entries ?? [])
    .filter((entry) => isActiveProjectProfileEntry(entry))
    .filter((entry) => ["repo_detected", "config"].includes(entry.source))
    .sort((a, b) => b.precedence - a.precedence)
    .slice(0, 5);

  if (!entries.length) return "Project profile: none";

  return `Project profile: ${entries
    .map((entry) => `${entry.kind}/${entry.source}: ${packetText(entry.text, 120)}`)
    .join("; ")}`;
}

function profileEntryMentionsTask(entry: ProjectSensitivityProfileEntry, task: TaskRecord): boolean {
  const scope = entry.scope?.trim().toLowerCase();
  if (!scope) return false;
  const taskNeedles = [task.id, task.title, task.scope, ...task.file_scope]
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return taskNeedles.some((needle) => scope.includes(needle) || needle.includes(scope));
}

function renderTaskExtraDelta(task: TaskRecord, profile?: ProjectSensitivityProfile): string | undefined {
  const entries = (profile?.entries ?? [])
    .filter((entry) => isActiveProjectProfileEntry(entry))
    .filter((entry) => ["user", "mission", "tool"].includes(entry.source))
    .filter((entry) => profileEntryMentionsTask(entry, task))
    .sort((a, b) => b.precedence - a.precedence)
    .slice(0, 5);

  if (!entries.length) return undefined;

  const rendered = entries.map((entry) => {
    const date = entry.updated_at.slice(0, 10) || entry.created_at.slice(0, 10);
    const marker = entry.source === "user" ? `user-added source=${entry.source} date=${date} precedence=${entry.precedence}` : `source=${entry.source} date=${date} precedence=${entry.precedence}`;
    return `- ${entry.kind} (${marker}): ${packetText(entry.text, 160)}`;
  });

  return [`<ExtraDelta>`, `Only task-specific deltas from base worker rules/project profile:`, ...rendered, `</ExtraDelta>`].join("\n");
}

function emptyAcceptanceCoverage(): Record<AcceptanceCoverageBucket, number> {
  return { unmet: 0, claimed: 0, evidenced: 0, verified: 0 };
}

function criterionCoverageBucket(
  criterion: AcceptanceCriterion,
): AcceptanceCoverageBucket {
  if (criterion.met === true && criterion.evidence?.trim() && criterion.verification_type?.trim()) {
    return "verified";
  }
  if (criterion.evidence?.trim()) {
    return "evidenced";
  }
  if (criterion.met === true) {
    return "claimed";
  }
  return "unmet";
}

function normalizeCriteria(value: unknown): AcceptanceCriterion[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item): AcceptanceCriterion | undefined => {
      if (typeof item === "string" && item.trim()) {
        return { criterion: item.trim(), met: false };
      }
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return undefined;
      }
      const record = item as Record<string, unknown>;
      const criterion =
        typeof record.criterion === "string"
          ? record.criterion.trim()
          : typeof record.title === "string"
            ? record.title.trim()
            : "";
      if (!criterion) {
        return undefined;
      }
      return {
        criterion,
        ...(typeof record.met === "boolean" ? { met: record.met } : {}),
        ...(typeof record.evidence === "string"
          ? { evidence: record.evidence.trim() }
          : {}),
        ...(typeof record.verification_type === "string"
          ? { verification_type: record.verification_type.trim() }
          : {}),
      };
    })
    .filter((item): item is AcceptanceCriterion => Boolean(item));
}

function normalizeWorkerAgent(agent: string): WorkerAgent {
  if (!WORKER_AGENT_SET.has(agent)) {
    throw new Error(`Unsupported worker agent: ${agent}`);
  }
  return agent as WorkerAgent;
}

function normalizeScope(scope: string): string {
  const trimmed = scope.trim().replace(/\\/g, "/");
  if (!trimmed || trimmed === ".") return "*";
  return trimmed.replace(/^\.\//, "").replace(/\/+$/, "");
}

export function canonicalLockScope(scope: string, input?: { projectDirectory?: string; cwd?: string }): string {
  const normalized = normalizeScope(scope);
  if (normalized === "*") return normalized;

  const projectDirectory = input?.projectDirectory ? resolve(input.projectDirectory) : undefined;
  const cwd = input?.cwd ? resolve(input.cwd) : projectDirectory;
  const anchor = cwd ?? projectDirectory;
  if (!projectDirectory || !anchor) return normalized;

  const absolute = isAbsolute(normalized) ? normalized : resolve(anchor, normalized);
  const rel = relative(projectDirectory, absolute).replace(/\\/g, "/");
  return normalizeScope(rel.startsWith("..") ? absolute : rel);
}

const OPTIONAL_ID_NO_VALUE_TOKENS = new Set(["", "null", "none", "undefined"]);

export function normalizeOptionalID(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return OPTIONAL_ID_NO_VALUE_TOKENS.has(trimmed.toLowerCase()) ? undefined : trimmed;
}

function invalidReferenceError(field: string, value: string, target: string): Error {
  return new Error(
    `Invalid ${field}: ${value}. No matching ${target} exists. Use an existing ${target} id, omit ${field}, or pass null/none when this relationship is intentionally absent.`,
  );
}

function globPrefix(scope: string): string {
  const wildcardIndex = scope.search(/[!*?[{]/);
  if (wildcardIndex < 0) return scope;
  return scope.slice(0, wildcardIndex).replace(/\/+$/, "");
}

export function scopesOverlap(left: string, right: string): boolean {
  const a = normalizeScope(left);
  const b = normalizeScope(right);
  if (a === "*" || b === "*") return true;
  if (a === b) return true;

  const aPrefix = globPrefix(a);
  const bPrefix = globPrefix(b);
  if (!aPrefix || !bPrefix) return true;
  if (aPrefix === bPrefix) return true;

  return (
    aPrefix.startsWith(`${bPrefix}/`) ||
    bPrefix.startsWith(`${aPrefix}/`) ||
    a.startsWith(`${b}/`) ||
    b.startsWith(`${a}/`)
  );
}

function rowToMission(row: SqlRow | undefined): MissionRecord | undefined {
  if (!row) return undefined;
  return {
    id: String(row.id),
    title: String(row.title),
    goal: String(row.goal),
    status: row.status as MissionStatus,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    metadata: decodeJson<Record<string, unknown>>(row.metadata_json, {}),
  };
}

function rowToProject(row: SqlRow | undefined): ProjectRecord | undefined {
  if (!row) return undefined;
  return {
    id: String(row.id),
    name: String(row.name),
    root_path: String(row.root_path),
    ...(typeof row.project_key === "string" ? { project_key: String(row.project_key) } : {}),
    status: row.status as ProjectRecord["status"],
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    metadata: decodeJson<Record<string, unknown>>(row.metadata_json, {}),
  };
}

function rowToSession(row: SqlRow | undefined): SessionRecord | undefined {
  if (!row) return undefined;
  return {
    id: String(row.id),
    opencode_session_id: String(row.opencode_session_id),
    ...(typeof row.project_id === "string" ? { project_id: String(row.project_id) } : {}),
    cwd: String(row.cwd),
    machine_id: String(row.machine_id ?? getMachineId()),
    ...(typeof row.active_mission_id === "string" ? { active_mission_id: String(row.active_mission_id) } : {}),
    ...(typeof row.active_task_id === "string" ? { active_task_id: String(row.active_task_id) } : {}),
    ...(typeof row.agent === "string" ? { agent: String(row.agent) } : {}),
    ...(typeof row.parent_session_id === "string" ? { parent_session_id: String(row.parent_session_id) } : {}),
    status: row.status as SessionStatus,
    started_at: String(row.started_at),
    updated_at: String(row.updated_at),
    ...(typeof row.ended_at === "string" ? { ended_at: String(row.ended_at) } : {}),
    metadata: decodeJson<Record<string, unknown>>(row.metadata_json, {}),
  };
}

function rowToTask(row: SqlRow | undefined): TaskRecord | undefined {
  if (!row) return undefined;
  return {
    id: String(row.id),
    ...(typeof row.mission_id === "string" ? { mission_id: String(row.mission_id) } : {}),
    ...(typeof row.project_id === "string" ? { project_id: String(row.project_id) } : {}),
    ...(typeof row.parent_task_id === "string" ? { parent_task_id: String(row.parent_task_id) } : {}),
    backlog_status: (row.backlog_status ?? "none") as BacklogStatus,
    title: String(row.title),
    type: row.type as TaskType,
    assigned_agent: row.assigned_agent as WorkerAgent,
    status: row.status as TaskStatus,
    priority: row.priority as TaskPriority,
    dependencies: decodeJson<string[]>(row.dependencies_json, []),
    acceptance_criteria: normalizeCriteria(
      decodeJson<unknown[]>(row.acceptance_criteria_json, []),
    ),
    evidence_requirements: decodeJson<string[]>(row.evidence_requirements_json, []),
    scope: String(row.scope ?? ""),
    file_scope: decodeJson<string[]>(row.file_scope_json, []),
    verification: decodeJson<TaskVerification>(row.verification_json, {}),
    worker_report: decodeJson<Record<string, unknown>>(row.worker_report_json, {}),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function taskHasEvidence(task: TaskRecord): boolean {
  if (task.status === "cancelled") return true;
  if (task.verification.low_risk_exception?.trim()) return true;

  const hasPassingVerification =
    task.verification.result === "pass" &&
    task.verification.mode !== "mock" &&
    task.verification.mode !== "not_run" &&
    (task.verification.commands_or_actions?.length ?? 0) > 0;
  if (hasPassingVerification) return true;

  if (task.acceptance_criteria.length === 0) return false;
  return task.acceptance_criteria.every(
    (criterion) => criterion.met === true && Boolean(criterion.evidence?.trim()),
  );
}

function taskSkippedSafeRealCheck(task: TaskRecord): boolean {
  return (
    task.verification.mode === "not_run" &&
    task.verification.result !== "blocked" &&
    !task.verification.why_not_real?.trim() &&
    !task.verification.low_risk_exception?.trim()
  );
}

export function resolveLedgerPath(
  projectDirectory: string,
  config: HarnessConfig,
): string {
  const configured = config.orchestration?.ledger_path?.trim();
  const candidate = configured || join(defaultUserStateDirectory(), DEFAULT_LEDGER_FILENAME);
  return isAbsolute(candidate)
    ? resolve(candidate)
    : resolve(projectDirectory, candidate);
}

export function defaultUserStateDirectory(): string {
  const xdgStateHome = process.env.XDG_STATE_HOME?.trim();
  if (xdgStateHome) return join(xdgStateHome, "opencode-pair");
  if (platform() === "win32") {
    return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "opencode-pair");
  }
  if (platform() === "darwin") {
    return join(homedir(), "Library", "Application Support", "opencode-pair");
  }
  return join(homedir(), ".local", "state", "opencode-pair");
}

export function getMachineId(): string {
  const explicit = process.env.OPENCODE_PAIR_MACHINE_ID?.trim();
  if (explicit) return explicit;
  return `host:${createHash("sha256").update(hostname()).digest("hex").slice(0, 16)}`;
}

function canonicalGitRemote(value: string): string {
  return value.trim().replace(/^git@([^:]+):/, "https://$1/").replace(/\.git$/i, "").toLowerCase();
}

function readGitConfigRemote(rootPath: string): string | undefined {
  const configPath = join(rootPath, ".git", "config");
  if (!existsSync(configPath)) return undefined;
  const config = readFileSync(configPath, "utf8");
  const origin = config.match(/\[remote "origin"\][\s\S]*?\n\s*url\s*=\s*(.+)/);
  return origin?.[1] ? canonicalGitRemote(origin[1]) : undefined;
}

function readGitHeadFingerprint(rootPath: string): string | undefined {
  const headPath = join(rootPath, ".git", "HEAD");
  if (!existsSync(headPath)) return undefined;
  const head = readFileSync(headPath, "utf8").trim();
  if (/^[0-9a-f]{40}$/i.test(head)) return head.slice(0, 12);
  const ref = head.match(/^ref:\s*(.+)$/)?.[1];
  if (!ref) return undefined;
  const refPath = join(rootPath, ".git", ref);
  if (!existsSync(refPath)) return undefined;
  const commit = readFileSync(refPath, "utf8").trim();
  return /^[0-9a-f]{40}$/i.test(commit) ? commit.slice(0, 12) : undefined;
}

function parseProjectTextMarker(raw: string): Record<string, unknown> {
  const marker: Record<string, unknown> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    marker[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }
  return marker;
}

function readProjectMarker(rootPath: string): { marker: Record<string, unknown>; marker_path?: string; source: "txt" | "none" } {
  const txtPath = join(rootPath, DEFAULT_PROJECT_MARKER_RELATIVE_PATH);
  if (existsSync(txtPath)) {
    return { marker: parseProjectTextMarker(readFileSync(txtPath, "utf8")), marker_path: DEFAULT_PROJECT_MARKER_RELATIVE_PATH, source: "txt" };
  }
  return { marker: {}, source: "none" };
}

function findIdentityRoot(pathOrRoot: string): string {
  let current = resolve(pathOrRoot);
  while (true) {
    if (existsSync(join(current, DEFAULT_PROJECT_MARKER_RELATIVE_PATH)) || existsSync(join(current, ".git"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return resolve(pathOrRoot);
    current = parent;
  }
}

function deriveProjectIdentity(rootPath: string, metadata?: Record<string, unknown>): Record<string, unknown> {
  const marker = readProjectMarker(rootPath);
  const markerKey = typeof marker.marker.project_key === "string" ? marker.marker.project_key.trim() : "";
  const metadataKey = typeof metadata?.project_key === "string" ? metadata.project_key.trim() : "";
  const remote = readGitConfigRemote(rootPath);
  const head = readGitHeadFingerprint(rootPath);
  const gitKey = remote ? `git:${remote}${head ? `#${head}` : ""}` : undefined;
  return {
    project_key: markerKey || metadataKey || gitKey,
    name: typeof marker.marker.name === "string" ? marker.marker.name : undefined,
    repo_fingerprint: typeof marker.marker.repo_fingerprint === "string" ? marker.marker.repo_fingerprint : gitKey,
    git_remote_canonical: remote,
    marker_path: markerKey ? marker.marker_path : undefined,
    marker_source: marker.source === "none" ? undefined : marker.source,
  };
}

export class OrchestratorLedger {
  readonly dbPath: string;
  private readonly db: Database;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.migrate();
  }

  private getTableColumns(
    table: keyof typeof REQUIRED_LEDGER_COLUMNS,
  ): Set<string> {
    const rows = this.db.query(`PRAGMA table_info(${table})`).all() as SqlRow[];
    return new Set(
      rows
        .map((row) => (typeof row.name === "string" ? row.name : undefined))
        .filter((name): name is string => Boolean(name)),
    );
  }

  private assertCompatibleSchema(): void {
    const missing: string[] = [];

    for (const [table, columns] of Object.entries(REQUIRED_LEDGER_COLUMNS) as Array<
      [keyof typeof REQUIRED_LEDGER_COLUMNS, readonly string[]]
    >) {
      const available = this.getTableColumns(table);
      for (const column of columns) {
        if (!available.has(column)) {
          missing.push(`${table}.${column}`);
        }
      }
    }

    if (missing.length === 0) {
      return;
    }

    throw new Error(
      `Incompatible orchestrator ledger schema at ${this.dbPath}. Missing required columns: ${missing.join(
        ", ",
      )}. Reset the ignored local ledger database and restart OpenCode.`,
    );
  }

  private migrate(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS missions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        goal TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL UNIQUE,
        project_key TEXT UNIQUE,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS project_root_aliases (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        machine_id TEXT NOT NULL,
        root_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, machine_id, root_path)
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        mission_id TEXT REFERENCES missions(id) ON DELETE CASCADE,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        parent_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        backlog_status TEXT NOT NULL DEFAULT 'none',
        title TEXT NOT NULL,
        type TEXT NOT NULL,
        assigned_agent TEXT NOT NULL,
        status TEXT NOT NULL,
        priority TEXT NOT NULL,
        dependencies_json TEXT NOT NULL DEFAULT '[]',
        acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
        evidence_requirements_json TEXT NOT NULL DEFAULT '[]',
        scope TEXT NOT NULL DEFAULT '',
        file_scope_json TEXT NOT NULL DEFAULT '[]',
        verification_json TEXT NOT NULL DEFAULT '{}',
        worker_report_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS context_bundles (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        created_by TEXT NOT NULL,
        tags_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS blockers (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        severity TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        required_user_input INTEGER NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );

      CREATE TABLE IF NOT EXISTS file_locks (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        owner_agent TEXT NOT NULL,
        machine_id TEXT NOT NULL DEFAULT '',
        scope TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        released_at TEXT
      );

      CREATE TABLE IF NOT EXISTS verification_results (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        verdict TEXT NOT NULL,
        gate_status TEXT NOT NULL,
        report_json TEXT NOT NULL DEFAULT '{}',
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        opencode_session_id TEXT NOT NULL UNIQUE,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        cwd TEXT NOT NULL,
        machine_id TEXT NOT NULL DEFAULT '',
        active_mission_id TEXT REFERENCES missions(id) ON DELETE SET NULL,
        active_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        agent TEXT,
        parent_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        ended_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );

    `);

    this.addColumnIfMissing("projects", "project_key", "TEXT");
    this.addColumnIfMissing("sessions", "machine_id", "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing("file_locks", "machine_id", "TEXT NOT NULL DEFAULT ''");
    this.db
      .query("UPDATE sessions SET machine_id = $machineID WHERE machine_id = ''")
      .run({ $machineID: getMachineId() });
    this.db
      .query("UPDATE file_locks SET machine_id = $machineID WHERE machine_id = ''")
      .run({ $machineID: getMachineId() });

    this.assertCompatibleSchema();

    this.db.exec(`

      CREATE INDEX IF NOT EXISTS idx_projects_root ON projects(root_path);
      CREATE INDEX IF NOT EXISTS idx_projects_key ON projects(project_key);
      CREATE INDEX IF NOT EXISTS idx_project_aliases_root ON project_root_aliases(root_path, machine_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_mission_status ON tasks(mission_id, status);
      CREATE INDEX IF NOT EXISTS idx_tasks_project_backlog ON tasks(project_id, backlog_status, status);
      CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id);
      CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(task_id);
      CREATE INDEX IF NOT EXISTS idx_artifacts_project ON artifacts(project_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_context_task ON context_bundles(task_id);
      CREATE INDEX IF NOT EXISTS idx_context_project ON context_bundles(project_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_blockers_mission_status ON blockers(mission_id, status);
      CREATE INDEX IF NOT EXISTS idx_locks_mission_status ON file_locks(mission_id, status);
      CREATE INDEX IF NOT EXISTS idx_locks_machine ON file_locks(machine_id, mission_id, status);
      CREATE INDEX IF NOT EXISTS idx_verification_task ON verification_results(task_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_project_status ON sessions(project_id, status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_active_task ON sessions(active_task_id);
      PRAGMA user_version = ${CURRENT_LEDGER_SCHEMA_VERSION};
    `);
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const rows = this.db.query(`PRAGMA table_info(${table})`).all() as SqlRow[];
    if (rows.some((row) => row.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private nextSequentialId(prefix: string, table: string, missionId?: string): string {
    const row = missionId
      ? (this.db
          .query(`SELECT COUNT(*) AS count FROM ${table} WHERE mission_id = $missionId`)
          .get({ $missionId: missionId }) as SqlRow)
      : (this.db.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as SqlRow);
    const count = Number(row?.count ?? 0) + 1;
    return `${prefix}-${String(count).padStart(3, "0")}`;
  }

  private missionId(missionId?: string): string {
    const resolved = missionId || this.getActiveMission()?.id;
    if (!resolved) {
      throw new Error("No active mission. Create one with orchestrator_mission_create first.");
    }
    return resolved;
  }

  getOrCreateProject(input: {
    root_path: string;
    name?: string;
    metadata?: Record<string, unknown>;
  }): ProjectRecord {
    const rootPath = resolve(input.root_path);
    const identity = deriveProjectIdentity(rootPath, input.metadata);
    const projectKey = typeof identity.project_key === "string" && identity.project_key.trim() ? identity.project_key.trim() : undefined;
    const byKey = projectKey ? this.getProjectByKey(projectKey) : undefined;
    if (byKey) {
      this.recordProjectAlias(byKey.id, rootPath);
      return this.updateProject({
        project_id: byKey.id,
        root_path: rootPath,
        name: input.name,
        metadata: { ...identity, ...(input.metadata ?? {}) },
      });
    }
    const existing = this.getProjectByRoot(rootPath);
    if (existing) {
      this.recordProjectAlias(existing.id, rootPath);
      if (projectKey && !existing.project_key) {
        return this.updateProject({
          project_id: existing.id,
          project_key: projectKey,
          metadata: { ...identity, ...(input.metadata ?? {}) },
        });
      }
      return existing;
    }

    const timestamp = now();
    const id = this.nextSequentialId("P", "projects");
    this.db
      .query(
        `INSERT INTO projects (id, name, root_path, project_key, status, created_at, updated_at, metadata_json)
         VALUES ($id, $name, $rootPath, $projectKey, 'active', $createdAt, $updatedAt, $metadata)`,
      )
      .run({
        $id: id,
        $name: input.name?.trim() || rootPath.split("/").filter(Boolean).at(-1) || rootPath,
        $rootPath: rootPath,
        $projectKey: projectKey ?? null,
        $createdAt: timestamp,
        $updatedAt: timestamp,
        $metadata: encodeJson({ ...identity, ...(input.metadata ?? {}) }),
      });
    this.recordProjectAlias(id, rootPath);
    return this.getProject(id)!;
  }

  getProject(id: string): ProjectRecord | undefined {
    return rowToProject(
      this.db.query("SELECT * FROM projects WHERE id = $id").get({ $id: id }) as SqlRow | undefined,
    );
  }

  getProjectByRoot(rootPath: string): ProjectRecord | undefined {
    return rowToProject(
      this.db
        .query("SELECT * FROM projects WHERE root_path = $rootPath")
        .get({ $rootPath: resolve(rootPath) }) as SqlRow | undefined,
    );
  }

  getProjectByKey(projectKey: string): ProjectRecord | undefined {
    return rowToProject(
      this.db
        .query("SELECT * FROM projects WHERE project_key = $projectKey AND status = 'active' ORDER BY updated_at DESC LIMIT 1")
        .get({ $projectKey: projectKey.trim() }) as SqlRow | undefined,
    );
  }

  getProjectByName(name: string): ProjectRecord | undefined {
    return rowToProject(
      this.db
        .query(
          "SELECT * FROM projects WHERE name = $name AND status = 'active' ORDER BY id LIMIT 1",
        )
        .get({ $name: name.trim() }) as SqlRow | undefined,
    );
  }

  resolveProject(pathOrRoot: string): ProjectRecord | undefined {
    const absolute = resolve(pathOrRoot);
    const identity = deriveProjectIdentity(findIdentityRoot(absolute));
    const projectKey = typeof identity.project_key === "string" ? identity.project_key.trim() : "";
    if (projectKey) {
      const byKey = this.getProjectByKey(projectKey);
      if (byKey) return byKey;
    }
    const aliasRows = this.db
      .query(
        `SELECT p.* FROM projects p
         JOIN project_root_aliases a ON a.project_id = p.id
         WHERE p.status = 'active' AND a.machine_id = $machineID
         ORDER BY length(a.root_path) DESC`,
      )
      .all({ $machineID: getMachineId() }) as SqlRow[];
    const aliasMatch = aliasRows.map(rowToProject).find((project): project is ProjectRecord => {
      if (!project) return false;
      const roots = this.projectAliases(project.id);
      return roots.some((root) => absolute === root || absolute.startsWith(`${root}/`));
    });
    if (aliasMatch) return aliasMatch;
    const rows = this.db
      .query("SELECT * FROM projects WHERE status = 'active' ORDER BY length(root_path) DESC")
      .all() as SqlRow[];
    return rows.map(rowToProject).find((project): project is ProjectRecord => {
      if (!project) return false;
      return absolute === project.root_path || absolute.startsWith(`${project.root_path}/`);
    });
  }

  updateProject(input: {
    project_id: string;
    root_path?: string;
    project_key?: string;
    name?: string;
    status?: ProjectRecord["status"];
    metadata?: Record<string, unknown>;
  }): ProjectRecord {
    const existing = this.getProject(input.project_id);
    if (!existing) throw new Error(`Unknown project: ${input.project_id}`);
    const rootPath = input.root_path ? resolve(input.root_path) : existing.root_path;
    this.db
      .query(
        `UPDATE projects SET name = $name, root_path = $rootPath, project_key = $projectKey, status = $status, metadata_json = $metadata, updated_at = $updatedAt
         WHERE id = $id`,
      )
      .run({
        $id: existing.id,
        $name: input.name?.trim() || existing.name,
        $rootPath: rootPath,
        $projectKey: input.project_key ?? existing.project_key ?? null,
        $status: input.status ?? existing.status,
        $metadata: encodeJson({ ...existing.metadata, ...(input.metadata ?? {}) }),
        $updatedAt: now(),
      });
    this.recordProjectAlias(existing.id, rootPath);
    return this.getProject(existing.id)!;
  }

  getProjectSensitivityProfile(projectID: string): ProjectSensitivityProfile | undefined {
    const project = this.getProject(projectID);
    if (!project) throw new Error(`Unknown project: ${projectID}`);
    return asProjectSensitivityProfile(project.metadata.sensitivity_profile);
  }

  updateProjectSensitivityProfile(input: {
    project_id: string;
    profile?: ProjectSensitivityProfile;
    append_entries?: Array<Omit<Partial<ProjectSensitivityProfileEntry>, "id" | "created_at" | "updated_at"> & { text: string }>;
  }): ProjectSensitivityProfile {
    const project = this.getProject(input.project_id);
    if (!project) throw new Error(`Unknown project: ${input.project_id}`);
    const timestamp = now();
    const existing = asProjectSensitivityProfile(project.metadata.sensitivity_profile) ?? {
      schema_version: 1 as const,
      updated_at: timestamp,
      entries: [],
    };
    const incoming = input.profile
      ? { ...input.profile, entries: input.profile.entries.map((entry) => ({ ...entry })) }
      : existing;
    const appended = (input.append_entries ?? []).map((entry) => makeProjectSensitivityEntry(entry, timestamp));
    const byID = new Map<string, ProjectSensitivityProfileEntry>();
    for (const entry of [...existing.entries, ...incoming.entries, ...appended]) {
      const prior = byID.get(entry.id);
      byID.set(entry.id, {
        ...(prior ?? entry),
        ...entry,
        updated_at: entry.updated_at || timestamp,
      });
    }
    const superseded = new Set<string>();
    for (const entry of byID.values()) {
      for (const targetID of entry.supersedes ?? []) superseded.add(targetID);
    }
    const profile: ProjectSensitivityProfile = {
      schema_version: 1,
      updated_at: timestamp,
      entries: [...byID.values()].map((entry) => superseded.has(entry.id) ? { ...entry, active: false } : entry),
    };
    this.updateProject({ project_id: input.project_id, metadata: { sensitivity_profile: profile } });
    return profile;
  }

  private recordProjectAlias(projectID: string, rootPath: string): void {
    const timestamp = now();
    this.db
      .query(
        `INSERT INTO project_root_aliases (project_id, machine_id, root_path, created_at, updated_at)
         VALUES ($projectID, $machineID, $rootPath, $createdAt, $updatedAt)
         ON CONFLICT(project_id, machine_id, root_path) DO UPDATE SET updated_at = excluded.updated_at`,
      )
      .run({
        $projectID: projectID,
        $machineID: getMachineId(),
        $rootPath: resolve(rootPath),
        $createdAt: timestamp,
        $updatedAt: timestamp,
      });
  }

  private projectAliases(projectID: string): string[] {
    const rows = this.db
      .query("SELECT root_path FROM project_root_aliases WHERE project_id = $projectID AND machine_id = $machineID")
      .all({ $projectID: projectID, $machineID: getMachineId() }) as SqlRow[];
    return rows.map((row) => String(row.root_path));
  }

  createMission(input: {
    title: string;
    goal: string;
    metadata?: Record<string, unknown>;
    sessionID?: string;
    agent?: string;
  }): MissionRecord {
    const timestamp = now();
    const id = `M-${randomUUID().slice(0, 8)}`;
    this.db
      .query(
        `INSERT INTO missions (id, title, goal, status, created_at, updated_at, metadata_json)
         VALUES ($id, $title, $goal, 'active', $createdAt, $updatedAt, $metadata)`,
      )
      .run({
        $id: id,
        $title: input.title.trim(),
        $goal: input.goal.trim(),
        $createdAt: timestamp,
        $updatedAt: timestamp,
        $metadata: encodeJson(input.metadata ?? {}),
      });
    if (input.sessionID) {
      this.linkSession(input.sessionID, id, undefined, input.agent ?? "mission-control");
    }
    return this.getMission(id)!;
  }

  getMission(id: string): MissionRecord | undefined {
    return rowToMission(
      this.db.query("SELECT * FROM missions WHERE id = $id").get({ $id: id }) as
        | SqlRow
        | undefined,
    );
  }

  getActiveMission(): MissionRecord | undefined {
    return rowToMission(
      this.db
        .query(
          "SELECT * FROM missions WHERE status IN ('active', 'blocked') ORDER BY updated_at DESC LIMIT 1",
        )
        .get() as SqlRow | undefined,
    );
  }

  linkSession(
    sessionID: string,
    missionID: string,
    taskID: string | undefined,
    agent: string,
  ): void {
    const task = taskID ? this.getTask(taskID) : undefined;
    this.attachSession({
      opencode_session_id: sessionID,
      cwd: process.cwd(),
      project_id: task?.project_id,
      active_mission_id: missionID,
      active_task_id: taskID,
      agent,
    });
  }

  attachSession(input: {
    opencode_session_id: string;
    project_id?: string;
    cwd: string;
    active_mission_id?: string;
    active_task_id?: string;
    agent?: string;
    parent_session_id?: string;
    status?: SessionStatus;
    metadata?: Record<string, unknown>;
  }): SessionRecord {
    const existing = this.getSession(input.opencode_session_id);
    const timestamp = now();
    const id = existing?.id ?? this.nextSequentialId("S", "sessions");
    const metadata = { ...(existing?.metadata ?? {}), ...(input.metadata ?? {}) };
    const projectID = normalizeOptionalID(input.project_id);
    const activeMissionID = normalizeOptionalID(input.active_mission_id);
    const activeTaskID = normalizeOptionalID(input.active_task_id);
    const parentSessionID = normalizeOptionalID(input.parent_session_id);
    if (projectID && !this.getProject(projectID)) throw invalidReferenceError("project_id", projectID, "project");
    if (activeMissionID && !this.getMission(activeMissionID)) throw invalidReferenceError("active_mission_id", activeMissionID, "mission");
    if (activeTaskID && !this.getTask(activeTaskID)) throw invalidReferenceError("active_task_id", activeTaskID, "task");
    if (parentSessionID && !this.getSessionById(parentSessionID)) throw invalidReferenceError("parent_session_id", parentSessionID, "session");
    this.db
      .query(
        `INSERT INTO sessions (
          id, opencode_session_id, project_id, cwd, machine_id, active_mission_id, active_task_id,
          agent, parent_session_id, status, started_at, updated_at, ended_at, metadata_json
        ) VALUES (
          $id, $opencodeSessionID, $projectID, $cwd, $machineID, $activeMissionID, $activeTaskID,
          $agent, $parentSessionID, $status, $startedAt, $updatedAt, NULL, $metadata
        ) ON CONFLICT(opencode_session_id) DO UPDATE SET
          project_id = excluded.project_id,
          cwd = excluded.cwd,
          machine_id = excluded.machine_id,
          active_mission_id = excluded.active_mission_id,
          active_task_id = excluded.active_task_id,
          agent = excluded.agent,
          parent_session_id = excluded.parent_session_id,
          status = excluded.status,
          updated_at = excluded.updated_at,
          ended_at = NULL,
          metadata_json = excluded.metadata_json`,
      )
      .run({
        $id: id,
        $opencodeSessionID: input.opencode_session_id,
        $projectID: projectID ?? null,
        $cwd: resolve(input.cwd),
        $machineID: getMachineId(),
        $activeMissionID: activeMissionID ?? null,
        $activeTaskID: activeTaskID ?? null,
        $agent: input.agent ?? null,
        $parentSessionID: parentSessionID ?? null,
        $status: input.status ?? "active",
        $startedAt: existing?.started_at ?? timestamp,
        $updatedAt: timestamp,
        $metadata: encodeJson(metadata),
      });
    return this.getSession(input.opencode_session_id)!;
  }

  updateSession(input: {
    opencode_session_id: string;
    project_id?: string | null;
    cwd?: string;
    active_mission_id?: string | null;
    active_task_id?: string | null;
    agent?: string | null;
    parent_session_id?: string | null;
    status?: SessionStatus;
    metadata?: Record<string, unknown>;
  }): SessionRecord {
    const existing = this.getSession(input.opencode_session_id);
    if (!existing) throw new Error(`Unknown session: ${input.opencode_session_id}`);
    const nextStatus = input.status ?? existing.status;
    const projectID = input.project_id === undefined ? existing.project_id : normalizeOptionalID(input.project_id);
    const activeMissionID = input.active_mission_id === undefined ? existing.active_mission_id : normalizeOptionalID(input.active_mission_id);
    const activeTaskID = input.active_task_id === undefined ? existing.active_task_id : normalizeOptionalID(input.active_task_id);
    const parentSessionID = input.parent_session_id === undefined ? existing.parent_session_id : normalizeOptionalID(input.parent_session_id);
    if (projectID && !this.getProject(projectID)) throw invalidReferenceError("project_id", projectID, "project");
    if (activeMissionID && !this.getMission(activeMissionID)) throw invalidReferenceError("active_mission_id", activeMissionID, "mission");
    if (activeTaskID && !this.getTask(activeTaskID)) throw invalidReferenceError("active_task_id", activeTaskID, "task");
    if (parentSessionID && !this.getSessionById(parentSessionID)) throw invalidReferenceError("parent_session_id", parentSessionID, "session");
    this.db
      .query(
        `UPDATE sessions SET
          project_id = $projectID,
          cwd = $cwd,
          machine_id = $machineID,
          active_mission_id = $activeMissionID,
          active_task_id = $activeTaskID,
          agent = $agent,
          parent_session_id = $parentSessionID,
          status = $status,
          updated_at = $updatedAt,
          ended_at = $endedAt,
          metadata_json = $metadata
         WHERE opencode_session_id = $opencodeSessionID`,
      )
      .run({
        $opencodeSessionID: input.opencode_session_id,
        $projectID: projectID ?? null,
        $cwd: input.cwd ? resolve(input.cwd) : existing.cwd,
        $machineID: getMachineId(),
        $activeMissionID: activeMissionID ?? null,
        $activeTaskID: activeTaskID ?? null,
        $agent: input.agent === undefined ? existing.agent ?? null : input.agent,
        $parentSessionID: parentSessionID ?? null,
        $status: nextStatus,
        $updatedAt: now(),
        $endedAt: nextStatus === "ended" || nextStatus === "crashed" ? now() : existing.ended_at ?? null,
        $metadata: encodeJson({ ...existing.metadata, ...(input.metadata ?? {}) }),
      });
    return this.getSession(input.opencode_session_id)!;
  }

  getSession(opencodeSessionID: string): SessionRecord | undefined {
    return rowToSession(
      this.db
        .query("SELECT * FROM sessions WHERE opencode_session_id = $opencodeSessionID AND machine_id = $machineID")
        .get({ $opencodeSessionID: opencodeSessionID, $machineID: getMachineId() }) as SqlRow | undefined,
    );
  }

  getSessionById(id: string): SessionRecord | undefined {
    return rowToSession(
      this.db.query("SELECT * FROM sessions WHERE id = $id").get({ $id: id }) as SqlRow | undefined,
    );
  }

  listProjectSessions(input: {
    project_id: string;
    status?: SessionStatus;
    limit?: number;
  }): SessionRecord[] {
    const rows = this.db
      .query(
        `SELECT * FROM sessions
         WHERE project_id = $projectID AND ($status IS NULL OR status = $status)
           AND machine_id = $machineID
         ORDER BY updated_at DESC
         LIMIT $limit`,
      )
      .all({
        $projectID: input.project_id,
        $status: input.status ?? null,
        $machineID: getMachineId(),
        $limit: Math.max(1, Math.min(input.limit ?? 10, 25)),
      }) as SqlRow[];
    return rows.map((row) => rowToSession(row)!);
  }

  linkSessionToTask(sessionID: string, taskID: string, agent: string): void {
    const task = this.getTask(taskID);
    if (!task) return;
    this.attachSession({
      opencode_session_id: sessionID,
      cwd: process.cwd(),
      project_id: task.project_id,
      active_mission_id: task.mission_id,
      active_task_id: taskID,
      agent,
    });
  }

  getSessionTask(sessionID: string): TaskRecord | undefined {
    const row = this.db
      .query("SELECT active_task_id FROM sessions WHERE opencode_session_id = $sessionID AND machine_id = $machineID")
      .get({ $sessionID: sessionID, $machineID: getMachineId() }) as SqlRow | undefined;
    if (typeof row?.active_task_id !== "string") return undefined;
    return this.getTask(row.active_task_id);
  }

  createTask(input: {
    mission_id?: string;
    project_id?: string;
    parent_task_id?: string | null;
    backlog_status?: BacklogStatus;
    title: string;
    type: TaskType;
    assigned_agent: string;
    priority?: TaskPriority;
    dependencies?: string[];
    acceptance_criteria?: Array<string | AcceptanceCriterion>;
    evidence_requirements?: string[];
    scope: string;
    file_scope?: string[];
    status?: TaskStatus;
  }): TaskRecord {
    const projectID = normalizeOptionalID(input.project_id);
    const explicitMissionID = normalizeOptionalID(input.mission_id);
    const parentTaskID = normalizeOptionalID(input.parent_task_id);
    if (projectID && !this.getProject(projectID)) throw invalidReferenceError("project_id", projectID, "project");
    if (explicitMissionID && !this.getMission(explicitMissionID)) throw invalidReferenceError("mission_id", explicitMissionID, "mission");
    if (parentTaskID && !this.getTask(parentTaskID)) throw invalidReferenceError("parent_task_id", parentTaskID, "task");
    const missionID = explicitMissionID ?? (projectID ? undefined : this.missionId());
    const timestamp = now();
    const id = this.nextSequentialId("T", "tasks");
    const assignedAgent = normalizeWorkerAgent(input.assigned_agent);
    this.db
      .query(
        `INSERT INTO tasks (
          id, mission_id, project_id, parent_task_id, backlog_status,
          title, type, assigned_agent, status, priority,
          dependencies_json, acceptance_criteria_json, evidence_requirements_json,
          scope, file_scope_json, verification_json, worker_report_json, created_at, updated_at
        ) VALUES (
          $id, $missionID, $projectID, $parentTaskID, $backlogStatus,
          $title, $type, $assignedAgent, $status, $priority,
          $dependencies, $criteria, $evidenceRequirements,
          $scope, $fileScope, '{}', '{}', $createdAt, $updatedAt
        )`,
      )
      .run({
        $id: id,
        $missionID: missionID ?? null,
        $projectID: projectID ?? null,
        $parentTaskID: parentTaskID ?? null,
        $backlogStatus: input.backlog_status ?? "none",
        $title: input.title.trim(),
        $type: input.type,
        $assignedAgent: assignedAgent,
        $status: input.status ?? "pending",
        $priority: input.priority ?? "medium",
        $dependencies: encodeJson(input.dependencies ?? []),
        $criteria: encodeJson(normalizeCriteria(input.acceptance_criteria ?? [])),
        $evidenceRequirements: encodeJson(input.evidence_requirements ?? []),
        $scope: input.scope.trim(),
        $fileScope: encodeJson((input.file_scope ?? []).map(normalizeScope)),
        $createdAt: timestamp,
        $updatedAt: timestamp,
      });
    if (missionID) this.touchMission(missionID);
    return this.getTask(id)!;
  }

  getTask(id: string): TaskRecord | undefined {
    return rowToTask(
      this.db.query("SELECT * FROM tasks WHERE id = $id").get({ $id: id }) as
        | SqlRow
        | undefined,
    );
  }

  listTasks(missionID = this.missionId()): TaskRecord[] {
    return (this.db
      .query("SELECT * FROM tasks WHERE mission_id = $missionID ORDER BY id")
      .all({ $missionID: missionID }) as SqlRow[]).map((row) => rowToTask(row)!);
  }

  listProjectTasks(input: {
    project_id: string;
    backlog_status?: BacklogStatus;
    parent_task_id?: string | null;
  }): TaskRecord[] {
    const parentTaskID = normalizeOptionalID(input.parent_task_id);
    if (!this.getProject(input.project_id)) throw invalidReferenceError("project_id", input.project_id, "project");
    if (parentTaskID && !this.getTask(parentTaskID)) throw invalidReferenceError("parent_task_id", parentTaskID, "task");
    const rows = this.db
      .query(
        `SELECT * FROM tasks
         WHERE project_id = $projectID
           AND ($backlogStatus IS NULL OR backlog_status = $backlogStatus)
           AND ($parentTaskIDUnset = 1 OR parent_task_id = $parentTaskID OR ($parentTaskID IS NULL AND parent_task_id IS NULL))
         ORDER BY id`,
      )
      .all({
        $projectID: input.project_id,
        $backlogStatus: input.backlog_status ?? null,
        $parentTaskIDUnset: input.parent_task_id === undefined ? 1 : 0,
        $parentTaskID: parentTaskID ?? null,
      }) as SqlRow[];
    return rows.map((row) => rowToTask(row)!);
  }

  findAssignableTask(agent: string): TaskRecord | undefined {
    const mission = this.getActiveMission();
    if (!mission) return undefined;
    return rowToTask(
      this.db
        .query(
          `SELECT * FROM tasks
           WHERE mission_id = $missionID AND assigned_agent = $agent
             AND status NOT IN ('done', 'cancelled')
           ORDER BY CASE status
             WHEN 'in_progress' THEN 0
             WHEN 'reopened' THEN 1
             WHEN 'needs_verification' THEN 2
             WHEN 'pending' THEN 3
             WHEN 'blocked' THEN 4
             ELSE 5 END, updated_at DESC
           LIMIT 1`,
        )
        .get({ $missionID: mission.id, $agent: agent }) as SqlRow | undefined,
    );
  }

  updateTask(input: {
    task_id: string;
    status?: TaskStatus;
    summary?: string;
    acceptance_criteria?: AcceptanceCriterion[];
    verification?: TaskVerification;
    worker_report?: Record<string, unknown>;
    remaining_gaps?: string[];
  }): { task: TaskRecord; adjusted: boolean; reason?: string } {
    const existing = this.getTask(input.task_id);
    if (!existing) {
      throw new Error(`Unknown task: ${input.task_id}`);
    }

    const mergedCriteria = input.acceptance_criteria
      ? mergeCriteria(existing.acceptance_criteria, input.acceptance_criteria)
      : existing.acceptance_criteria;
    const mergedVerification = {
      ...existing.verification,
      ...(input.verification ?? {}),
    };
    const mergedReport = {
      ...existing.worker_report,
      ...(input.summary ? { summary: input.summary } : {}),
      ...(input.worker_report ?? {}),
      ...(input.remaining_gaps ? { remaining_gaps: input.remaining_gaps } : {}),
    };

    let nextStatus = input.status ?? existing.status;
    let adjusted = false;
    let reason: string | undefined;
    const probe: TaskRecord = {
      ...existing,
      status: nextStatus,
      acceptance_criteria: mergedCriteria,
      verification: mergedVerification,
      worker_report: mergedReport,
    };

    if (nextStatus === "done" && !taskHasEvidence(probe)) {
      nextStatus = "needs_verification";
      adjusted = true;
      reason =
        "Task cannot be marked done without evidence-backed verification or an explicit low-risk exception.";
    }

    this.db
      .query(
        `UPDATE tasks SET
          status = $status,
          acceptance_criteria_json = $criteria,
          verification_json = $verification,
          worker_report_json = $workerReport,
          updated_at = $updatedAt
         WHERE id = $id`,
      )
      .run({
        $id: existing.id,
        $status: nextStatus,
        $criteria: encodeJson(mergedCriteria),
        $verification: encodeJson(mergedVerification),
        $workerReport: encodeJson(mergedReport),
        $updatedAt: now(),
      });
    if (existing.mission_id) this.touchMission(existing.mission_id);
    return { task: this.getTask(existing.id)!, adjusted, reason };
  }

  reopenTask(input: {
    task_id: string;
    reason: string;
    created_by: string;
  }): TaskRecord {
    const task = this.getTask(input.task_id);
    if (!task) throw new Error(`Unknown task: ${input.task_id}`);
    this.updateTask({
      task_id: input.task_id,
      status: "reopened",
      worker_report: {
        reopened_reason: input.reason,
        reopened_by: input.created_by,
      },
    });
    return this.getTask(input.task_id)!;
  }

  publishArtifact(input: {
    mission_id?: string;
    project_id?: string;
    task_id?: string;
    type: string;
    title: string;
    content: string;
    created_by: string;
  }): { id: string } {
    const taskID = normalizeOptionalID(input.task_id);
    const missionInputID = normalizeOptionalID(input.mission_id);
    const projectInputID = normalizeOptionalID(input.project_id);
    const task = taskID ? this.getTask(taskID) : undefined;
    if (taskID && !task) throw invalidReferenceError("task_id", taskID, "task");
    if (missionInputID && !this.getMission(missionInputID)) throw invalidReferenceError("mission_id", missionInputID, "mission");
    if (projectInputID && !this.getProject(projectInputID)) throw invalidReferenceError("project_id", projectInputID, "project");
    const missionID = missionInputID ?? task?.mission_id ?? this.missionId();
    const projectID = projectInputID ?? task?.project_id;
    const id = this.nextSequentialId("A", "artifacts");
    this.db
      .query(
        `INSERT INTO artifacts (id, mission_id, project_id, task_id, type, title, content, created_by, created_at)
         VALUES ($id, $missionID, $projectID, $taskID, $type, $title, $content, $createdBy, $createdAt)`,
      )
      .run({
        $id: id,
        $missionID: missionID,
        $projectID: projectID ?? null,
        $taskID: taskID ?? null,
        $type: input.type,
        $title: input.title.trim(),
        $content: input.content.trim(),
        $createdBy: input.created_by,
        $createdAt: now(),
      });
    this.touchMission(missionID);
    return { id };
  }

  queryArtifacts(input: {
    mission_id?: string;
    project_id?: string;
    task_id?: string;
    type?: string;
    limit?: number;
  }): Array<{ id: string; task_id?: string; type: string; title: string; content: string }> {
    const taskID = normalizeOptionalID(input.task_id);
    const missionInputID = normalizeOptionalID(input.mission_id);
    const projectInputID = normalizeOptionalID(input.project_id);
    const task = taskID ? this.getTask(taskID) : undefined;
    if (taskID && !task) throw invalidReferenceError("task_id", taskID, "task");
    if (missionInputID && !this.getMission(missionInputID)) throw invalidReferenceError("mission_id", missionInputID, "mission");
    if (projectInputID && !this.getProject(projectInputID)) throw invalidReferenceError("project_id", projectInputID, "project");
    const missionID = missionInputID ?? task?.mission_id ?? (projectInputID ? undefined : this.missionId());
    const rows = this.db
      .query(
        `SELECT * FROM artifacts
         WHERE ($missionID IS NULL OR mission_id = $missionID)
           AND ($projectID IS NULL OR project_id = $projectID)
           AND ($taskID IS NULL OR task_id = $taskID)
           AND ($type IS NULL OR type = $type)
         ORDER BY created_at DESC
         LIMIT $limit`,
      )
      .all({
        $missionID: missionID ?? null,
        $projectID: projectInputID ?? task?.project_id ?? null,
        $taskID: taskID ?? null,
        $type: input.type ?? null,
        $limit: Math.max(1, Math.min(input.limit ?? 10, 25)),
      }) as SqlRow[];
    return rows.map((row) => ({
      id: String(row.id),
      ...(typeof row.task_id === "string" ? { task_id: String(row.task_id) } : {}),
      type: String(row.type),
      title: String(row.title),
      content: compactText(String(row.content), 1200),
    }));
  }

  publishContextBundle(input: {
    mission_id?: string;
    project_id?: string;
    task_id?: string;
    title: string;
    content: string;
    created_by: string;
    tags?: string[];
  }): { id: string } {
    const taskID = normalizeOptionalID(input.task_id);
    const missionInputID = normalizeOptionalID(input.mission_id);
    const projectInputID = normalizeOptionalID(input.project_id);
    const task = taskID ? this.getTask(taskID) : undefined;
    if (taskID && !task) throw invalidReferenceError("task_id", taskID, "task");
    if (missionInputID && !this.getMission(missionInputID)) throw invalidReferenceError("mission_id", missionInputID, "mission");
    if (projectInputID && !this.getProject(projectInputID)) throw invalidReferenceError("project_id", projectInputID, "project");
    const missionID = missionInputID ?? task?.mission_id ?? this.missionId();
    const projectID = projectInputID ?? task?.project_id;
    const id = this.nextSequentialId("CB", "context_bundles");
    this.db
      .query(
        `INSERT INTO context_bundles (id, mission_id, project_id, task_id, title, content, created_by, tags_json, created_at)
         VALUES ($id, $missionID, $projectID, $taskID, $title, $content, $createdBy, $tags, $createdAt)`,
      )
      .run({
        $id: id,
        $missionID: missionID,
        $projectID: projectID ?? null,
        $taskID: taskID ?? null,
        $title: input.title.trim(),
        $content: input.content.trim(),
        $createdBy: input.created_by,
        $tags: encodeJson(input.tags ?? []),
        $createdAt: now(),
      });
    this.touchMission(missionID);
    return { id };
  }

  queryContextBundles(input: {
    mission_id?: string;
    project_id?: string;
    task_id?: string;
    tags?: string[];
    limit?: number;
  }): Array<{ id: string; task_id?: string; title: string; content: string; tags: string[] }> {
    const taskID = normalizeOptionalID(input.task_id);
    const missionInputID = normalizeOptionalID(input.mission_id);
    const projectInputID = normalizeOptionalID(input.project_id);
    const task = taskID ? this.getTask(taskID) : undefined;
    if (taskID && !task) throw invalidReferenceError("task_id", taskID, "task");
    if (missionInputID && !this.getMission(missionInputID)) throw invalidReferenceError("mission_id", missionInputID, "mission");
    if (projectInputID && !this.getProject(projectInputID)) throw invalidReferenceError("project_id", projectInputID, "project");
    const missionID = missionInputID ?? task?.mission_id ?? (projectInputID ? undefined : this.missionId());
    const rows = this.db
      .query(
        `SELECT * FROM context_bundles
         WHERE ($missionID IS NULL OR mission_id = $missionID)
           AND ($projectID IS NULL OR project_id = $projectID)
           AND ($taskID IS NULL OR task_id = $taskID)
         ORDER BY created_at DESC
         LIMIT $limit`,
      )
      .all({
        $missionID: missionID ?? null,
        $projectID: projectInputID ?? task?.project_id ?? null,
        $taskID: taskID ?? null,
        $limit: Math.max(1, Math.min(input.limit ?? 10, 25)),
      }) as SqlRow[];
    const tagFilter = new Set(input.tags ?? []);
    return rows
      .map((row) => ({
        id: String(row.id),
        ...(typeof row.task_id === "string" ? { task_id: String(row.task_id) } : {}),
        title: String(row.title),
        content: compactText(String(row.content), 1200),
        tags: decodeJson<string[]>(row.tags_json, []),
      }))
      .filter((bundle) => {
        if (tagFilter.size === 0) return true;
        return bundle.tags.some((tag) => tagFilter.has(tag));
      });
  }

  searchContext(input: {
    project_id?: string;
    mission_id?: string;
    task_id?: string;
    tags?: string[];
    query?: string;
    include_artifacts?: boolean;
    include_bundles?: boolean;
    limit?: number;
  }): Array<{
    source: ContextSourceType;
    id: string;
    task_id?: string;
    type?: string;
    title: string;
    content: string;
    tags?: string[];
  }> {
    const query = input.query?.trim().toLowerCase();
    const limit = Math.max(1, Math.min(input.limit ?? 10, 25));
    const includeBundles = input.include_bundles !== false;
    const includeArtifacts = input.include_artifacts !== false;
    const results: Array<{
      source: ContextSourceType;
      id: string;
      task_id?: string;
      type?: string;
      title: string;
      content: string;
      tags?: string[];
    }> = [];

    if (includeBundles) {
      results.push(
        ...this.queryContextBundles(input).map((bundle) => ({
          source: "context_bundle" as const,
          ...bundle,
        })),
      );
    }
    if (includeArtifacts) {
      results.push(
        ...this.queryArtifacts(input).map((artifact) => ({
          source: "artifact" as const,
          ...artifact,
        })),
      );
    }

    return results
      .filter((item) => {
        if (!query) return true;
        return `${item.title}\n${item.content}\n${item.type ?? ""}\n${item.tags?.join(" ") ?? ""}`
          .toLowerCase()
          .includes(query);
      })
      .slice(0, limit);
  }

  recordDecision(input: {
    mission_id?: string;
    task_id?: string;
    title: string;
    content: string;
    created_by: string;
  }): { id: string } {
    const taskID = normalizeOptionalID(input.task_id);
    const missionInputID = normalizeOptionalID(input.mission_id);
    const task = taskID ? this.getTask(taskID) : undefined;
    if (taskID && !task) throw invalidReferenceError("task_id", taskID, "task");
    if (missionInputID && !this.getMission(missionInputID)) throw invalidReferenceError("mission_id", missionInputID, "mission");
    const missionID = missionInputID ?? task?.mission_id ?? this.missionId();
    const id = this.nextSequentialId("D", "decisions");
    this.db
      .query(
        `INSERT INTO decisions (id, mission_id, task_id, title, content, created_by, created_at)
         VALUES ($id, $missionID, $taskID, $title, $content, $createdBy, $createdAt)`,
      )
      .run({
        $id: id,
        $missionID: missionID,
        $taskID: taskID ?? null,
        $title: input.title.trim(),
        $content: input.content.trim(),
        $createdBy: input.created_by,
        $createdAt: now(),
      });
    this.touchMission(missionID);
    return { id };
  }

  createBlocker(input: {
    mission_id?: string;
    task_id?: string;
    severity: "low" | "medium" | "high" | "critical";
    title: string;
    description: string;
    required_user_input: boolean;
    created_by: string;
  }): { id: string } {
    const taskID = normalizeOptionalID(input.task_id);
    const missionInputID = normalizeOptionalID(input.mission_id);
    const task = taskID ? this.getTask(taskID) : undefined;
    if (taskID && !task) throw invalidReferenceError("task_id", taskID, "task");
    if (missionInputID && !this.getMission(missionInputID)) throw invalidReferenceError("mission_id", missionInputID, "mission");
    const missionID = missionInputID ?? task?.mission_id ?? this.missionId();
    const id = this.nextSequentialId("B", "blockers");
    this.db
      .query(
        `INSERT INTO blockers (
          id, mission_id, task_id, severity, title, description, status,
          required_user_input, created_by, created_at
        ) VALUES (
          $id, $missionID, $taskID, $severity, $title, $description, 'open',
          $requiredUserInput, $createdBy, $createdAt
        )`,
      )
      .run({
        $id: id,
        $missionID: missionID,
        $taskID: taskID ?? null,
        $severity: input.severity,
        $title: input.title.trim(),
        $description: input.description.trim(),
        $requiredUserInput: input.required_user_input ? 1 : 0,
        $createdBy: input.created_by,
        $createdAt: now(),
      });
    if (taskID) {
      this.updateTask({ task_id: taskID, status: "blocked" });
    }
    this.touchMission(missionID, "blocked");
    return { id };
  }

  resolveBlocker(input: {
    blocker_id: string;
    resolution: string;
    resolved_by: string;
  }): { resolved: boolean } {
    const blocker = this.db
      .query("SELECT * FROM blockers WHERE id = $id")
      .get({ $id: input.blocker_id }) as SqlRow | undefined;
    if (!blocker) {
      throw new Error(`Unknown blocker: ${input.blocker_id}`);
    }
    const result = this.db
      .query(
        `UPDATE blockers
         SET status = 'resolved', resolved_at = $resolvedAt, description = description || $resolution
         WHERE id = $id AND status = 'open'`,
      )
      .run({
        $id: input.blocker_id,
        $resolvedAt: now(),
        $resolution: `\n\nResolution (${input.resolved_by}): ${input.resolution.trim()}`,
      });
    this.touchMission(String(blocker.mission_id), "active");
    return { resolved: Number(result.changes ?? 0) > 0 };
  }

  recordVerification(input: {
    mission_id?: string;
    task_id?: string;
    verdict: "approve" | "request-changes";
    gate_status: "pass" | "fail";
    report: Record<string, unknown>;
    created_by: string;
  }): { id: string } {
    const taskID = normalizeOptionalID(input.task_id);
    const missionInputID = normalizeOptionalID(input.mission_id);
    const task = taskID ? this.getTask(taskID) : undefined;
    if (taskID && !task) throw invalidReferenceError("task_id", taskID, "task");
    if (missionInputID && !this.getMission(missionInputID)) throw invalidReferenceError("mission_id", missionInputID, "mission");
    const missionID = missionInputID ?? task?.mission_id ?? this.missionId();
    const id = this.nextSequentialId("V", "verification_results");
    this.db
      .query(
        `INSERT INTO verification_results (id, mission_id, task_id, verdict, gate_status, report_json, created_by, created_at)
         VALUES ($id, $missionID, $taskID, $verdict, $gateStatus, $report, $createdBy, $createdAt)`,
      )
      .run({
        $id: id,
        $missionID: missionID,
        $taskID: taskID ?? null,
        $verdict: input.verdict,
        $gateStatus: input.gate_status,
        $report: encodeJson(input.report),
        $createdBy: input.created_by,
        $createdAt: now(),
      });

    const tasksToReopen = decodeTasksToReopen(input.report);
    for (const taskID of tasksToReopen) {
      this.reopenTask({
        task_id: taskID,
        reason: "Verification requested changes.",
        created_by: input.created_by,
      });
    }
    if (taskID && input.verdict === "approve" && input.gate_status === "pass") {
      const task = this.getTask(taskID);
      if (task && task.status !== "done" && task.status !== "cancelled") {
        this.updateTask({
          task_id: taskID,
          status: "done",
          verification: {
            ...task.verification,
            mode: task.verification.mode ?? "local",
            result: "pass",
            commands_or_actions: task.verification.commands_or_actions?.length
              ? task.verification.commands_or_actions
              : ["verification-engineer approval"],
          },
        });
      }
    }
    this.touchMission(missionID);
    return { id };
  }

  checkGate(missionID = this.missionId()): GateCheckResult {
    const tasks = this.listTasks(missionID);
    const openTasks = tasks.filter(
      (task) => task.status !== "done" && task.status !== "cancelled",
    );
    const blockers = this.openBlockers(missionID);
    const missingEvidence: GateCheckResult["missing_evidence"] = [];
    const verificationIssues: GateCheckResult["verification_issues"] = [];

    for (const task of tasks) {
      if (task.status === "done" && !taskHasEvidence(task)) {
        missingEvidence.push({
          task_id: task.id,
          reason: "Task is done without evidence-backed verification.",
        });
      }
      if (task.status === "done") {
        for (const criterion of task.acceptance_criteria) {
          if (criterion.met !== true || !criterion.evidence?.trim()) {
            missingEvidence.push({
              task_id: task.id,
              criterion: criterion.criterion,
              reason: "Acceptance criterion lacks met=true evidence.",
            });
          }
        }
      }
      if (taskSkippedSafeRealCheck(task)) {
        verificationIssues.push({
          task_id: task.id,
          issue: "Safe real verification was skipped without a reason.",
        });
      }
    }

    const criticalVerifierIssues = this.latestVerificationIssues(missionID);
    verificationIssues.push(...criticalVerifierIssues);

    const onlyUserBlockers =
      openTasks.length > 0 &&
      openTasks.every((task) => task.status === "blocked") &&
      blockers.length > 0 &&
      blockers.every((blocker) => Boolean(blocker.required_user_input));

    const pass =
      openTasks.length === 0 &&
      blockers.length === 0 &&
      missingEvidence.length === 0 &&
      verificationIssues.length === 0;

    const gateStatus: GateStatus = pass ? "pass" : onlyUserBlockers ? "blocked" : "fail";
    return {
      mission_id: missionID,
      gate_status: gateStatus,
      can_final_success: pass,
      can_checkpoint_blockers: gateStatus === "blocked",
      open_tasks: openTasks.map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        assigned_agent: task.assigned_agent,
      })),
      unresolved_blockers: blockers.map((blocker) => ({
        id: String(blocker.id),
        ...(typeof blocker.task_id === "string" ? { task_id: String(blocker.task_id) } : {}),
        severity: String(blocker.severity),
        title: String(blocker.title),
        required_user_input: Boolean(blocker.required_user_input),
      })),
      missing_evidence: missingEvidence,
      verification_issues: verificationIssues,
      next_required_actions: buildGateActions(
        openTasks,
        blockers,
        missingEvidence,
        verificationIssues,
      ),
    };
  }

  buildFlightDeckReport(input: {
    mission_id?: string;
    project_id?: string;
    limit?: number;
  } = {}): FlightDeckReport | undefined {
    const limit = input.limit ?? 8;
    const mission = input.mission_id
      ? this.getMission(input.mission_id)
      : input.project_id
        ? undefined
        : this.getActiveMission();
    const project = input.project_id ? this.getProject(input.project_id) : undefined;

    if (input.mission_id && !mission) return undefined;
    if (input.project_id && !project) return undefined;
    if (!mission && !project) return undefined;

    const tasks = mission
      ? this.listTasks(mission.id)
      : this.listProjectTasks({ project_id: project!.id });
    const taskIDs = new Set(tasks.map((task) => task.id));
    const taskByID = new Map(tasks.map((task) => [task.id, task]));
    const taskCounts = countBy(tasks.map((task) => task.status));
    const acceptanceCoverage = { ...emptyAcceptanceCoverage(), total: 0 };
    const lanes: FlightDeckReport["lanes"] = {
      ready: [],
      blocked: [],
      needs_verification: [],
      in_progress: [],
      done: [],
      other: [],
    };

    const summarizeTask = (task: TaskRecord): FlightDeckTaskSummary => {
      const acceptance = emptyAcceptanceCoverage();
      for (const criterion of task.acceptance_criteria) {
        const bucket = criterionCoverageBucket(criterion);
        acceptance[bucket] += 1;
        acceptanceCoverage[bucket] += 1;
        acceptanceCoverage.total += 1;
      }
      return {
        id: task.id,
        title: task.title,
        status: task.status,
        assigned_agent: task.assigned_agent,
        priority: task.priority,
        dependencies: task.dependencies,
        acceptance,
      };
    };

    const isReady = (task: TaskRecord): boolean =>
      (task.status === "pending" || task.status === "reopened") &&
      task.dependencies.every((id) => {
        const dep = taskByID.get(id) ?? this.getTask(id);
        return !dep || dep.status === "done";
      });

    for (const task of tasks) {
      const summary = summarizeTask(task);
      if (isReady(task)) lanes.ready.push(summary);
      else if (task.status === "blocked") lanes.blocked.push(summary);
      else if (task.status === "needs_verification") lanes.needs_verification.push(summary);
      else if (task.status === "in_progress") lanes.in_progress.push(summary);
      else if (task.status === "done") lanes.done.push(summary);
      else lanes.other.push(summary);
    }

    const priorityRank: Record<TaskPriority, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    for (const lane of Object.values(lanes)) {
      lane.sort((left, right) => priorityRank[left.priority] - priorityRank[right.priority] || left.id.localeCompare(right.id));
      lane.splice(limit);
    }

    const gate = mission ? this.checkGate(mission.id) : undefined;
    const nextSafestAction = gate?.next_required_actions[0]
      ?? (lanes.blocked[0]
        ? `Resolve blocker for ${lanes.blocked[0].id}: ${compactText(lanes.blocked[0].title, 100)}`
        : lanes.needs_verification[0]
          ? `Verify ${lanes.needs_verification[0].id}: ${compactText(lanes.needs_verification[0].title, 100)}`
          : lanes.ready[0]
            ? `Delegate or resume ${lanes.ready[0].id}: ${compactText(lanes.ready[0].title, 100)}`
            : lanes.in_progress[0]
              ? `Check progress on ${lanes.in_progress[0].id}: ${compactText(lanes.in_progress[0].title, 100)}`
              : "No open task action found; check gate before claiming final success.");

    return {
      ok: true,
      scope: mission ? "mission" : "project",
      ...(mission ? { mission } : {}),
      ...(project ? { project } : {}),
      generated_at: now(),
      task_counts: taskCounts,
      lanes,
      acceptance_coverage: acceptanceCoverage,
      ...(gate ? { gate } : {}),
      next_safest_action: nextSafestAction,
    };
  }

  buildMissionSnapshot(sessionID?: string): string {
    const mission = sessionID ? this.getLinkedMission(sessionID) ?? this.getActiveMission() : this.getActiveMission();
    if (!mission) {
      return "[MissionLedger] No active mission. Create one with orchestrator_mission_create before delegating work.";
    }
    const tasks = this.listTasks(mission.id);
    const counts = countBy(tasks.map((task) => task.status));
    const open = tasks
      .filter((task) => task.status !== "done" && task.status !== "cancelled")
      .slice(0, 8)
      .map(
        (task) =>
          `${task.id}:${task.status}:${task.assigned_agent}:${compactText(task.title, 80)}`,
      );
    const blockers = this.openBlockers(mission.id).map(
      (blocker) => `${blocker.id}:${blocker.severity}:${compactText(String(blocker.title), 80)}`,
    );
    const gate = this.checkGate(mission.id);
    return [
      `[MissionLedger] ${mission.id} ${mission.status} — ${compactText(mission.title, 120)}`,
      `Goal: ${compactText(mission.goal, 220)}`,
      `Tasks: ${Object.entries(counts)
        .map(([status, count]) => `${status}=${count}`)
        .join(", ") || "none"}`,
      open.length ? `Open: ${open.join("; ")}` : "Open: none",
      blockers.length ? `Blockers: ${blockers.join("; ")}` : "Blockers: none",
      `Gate: ${gate.gate_status}; final_success=${gate.can_final_success}`,
    ].join("\n");
  }

  buildWorkerPacket(sessionID: string, agent: string): string {
    const task = this.getSessionTask(sessionID) ?? this.findAssignableTask(agent);
    if (!task) {
      return "[TaskLedger] No task packet is linked to this worker session. Ask Mission Control for a ledger task packet instead of improvising scope.";
    }
    if (!task.mission_id) {
      return "[TaskLedger] The linked task is project backlog work and is not attached to a mission packet yet.";
    }
    const mission = this.getMission(task.mission_id)!;
    const dependencies = task.dependencies
      .map((id) => this.getTask(id))
      .filter((item): item is TaskRecord => Boolean(item));
    const bundles = this.queryContextBundles({
      mission_id: task.mission_id,
      task_id: task.id,
      limit: 5,
    });
    const projectProfile = task.project_id ? this.getProjectSensitivityProfile(task.project_id) : undefined;
    const extraDelta = renderTaskExtraDelta(task, projectProfile);
    return [
      `<InheritedContext>`,
      `Mission: ${mission.id} ${mission.status} — ${packetText(mission.title, 120)}`,
      `Project: ${task.project_id ?? "none"}`,
      `Agent: ${task.assigned_agent}`,
      `Dependencies: ${dependencies.length ? dependencies.map((dep) => `${dep.id}:${dep.status}`).join(", ") : "none"}`,
      renderProjectSensitivityProfile(projectProfile),
      bundles.length
        ? `Context bundles: ${bundles.map((bundle) => `${bundle.id}:${packetText(bundle.title, 60)}=${packetText(bundle.content, 180)}`).join("; ")}`
        : "Context bundles: none",
      `</InheritedContext>`,
      `<TaskFacts>`,
      `Task: ${task.id} ${task.status} priority=${task.priority}`,
      `Title: ${packetText(task.title, 160)}`,
      `Scope: ${packetText(task.scope, 260)}`,
      `File scope: ${task.file_scope.length ? task.file_scope.map((item) => packetText(item, 120)).join(", ") : "none"}`,
      `Acceptance: ${task.acceptance_criteria.length ? task.acceptance_criteria.map((item) => `${item.met ? "[x]" : "[ ]"} ${packetText(item.criterion, 120)}`).join("; ") : "none recorded"}`,
      `Evidence required: ${task.evidence_requirements.length ? task.evidence_requirements.map((item) => packetText(item, 120)).join("; ") : "real/local/sandbox evidence or explicit low-risk exception"}`,
      `</TaskFacts>`,
      extraDelta,
      `<Task>`,
      `Complete ${task.id}: ${packetText(task.title, 160)}`,
      "Inspect the repo evidence, stay inside scope/file_scope, satisfy acceptance criteria, verify with relevant local checks, publish useful ledger evidence, and return the base worker JSON report.",
      `</Task>`,
    ].filter((line): line is string => Boolean(line)).join("\n");
  }

  buildCompactionSnapshot(sessionID: string): string {
    const mission = this.getLinkedMission(sessionID) ?? this.getActiveMission();
    if (!mission) {
      return "[MissionCompaction] No active mission in the orchestration ledger.";
    }
    const tasks = this.listTasks(mission.id);
    const blockers = this.openBlockers(mission.id);
    const decisions = this.db
      .query(
        "SELECT id, title, content FROM decisions WHERE mission_id = $missionID ORDER BY created_at DESC LIMIT 8",
      )
      .all({ $missionID: mission.id }) as SqlRow[];
    const gate = this.checkGate(mission.id);
    return [
      `[MissionCompaction] Preserve ledger state for ${mission.id}: ${compactText(mission.title, 120)}`,
      `Goal: ${compactText(mission.goal, 260)}`,
      `Open tasks: ${tasks
        .filter((task) => task.status !== "done" && task.status !== "cancelled")
        .map((task) => `${task.id}:${task.status}:${task.assigned_agent}:${compactText(task.title, 80)}`)
        .join("; ") || "none"}`,
      `Blockers: ${blockers.map((blocker) => `${blocker.id}:${blocker.severity}:${compactText(String(blocker.title), 90)}`).join("; ") || "none"}`,
      `Decisions: ${decisions.map((decision) => `${decision.id}:${compactText(String(decision.title), 80)}=${compactText(String(decision.content), 160)}`).join("; ") || "none"}`,
      `Gate: ${gate.gate_status}; next=${gate.next_required_actions.join(" | ") || "none"}`,
    ].join("\n");
  }

  relativePath(projectDirectory: string, filePath: string): string {
    const projectRoot = this.resolveProject(projectDirectory)?.root_path ?? projectDirectory;
  return canonicalLockScope(filePath, { projectDirectory: projectRoot, cwd: projectDirectory });
  }

  private getLinkedMission(sessionID: string): MissionRecord | undefined {
    const row = this.db
      .query("SELECT active_mission_id FROM sessions WHERE opencode_session_id = $sessionID AND machine_id = $machineID")
      .get({ $sessionID: sessionID, $machineID: getMachineId() }) as SqlRow | undefined;
    return typeof row?.active_mission_id === "string" ? this.getMission(row.active_mission_id) : undefined;
  }

  private touchMission(missionID: string, status?: MissionStatus): void {
    this.db
      .query(
        `UPDATE missions SET updated_at = $updatedAt${status ? ", status = $status" : ""} WHERE id = $id`,
      )
      .run({
        $id: missionID,
        $updatedAt: now(),
        ...(status ? { $status: status } : {}),
      });
  }

  private openBlockers(missionID: string): SqlRow[] {
    return this.db
      .query(
        "SELECT * FROM blockers WHERE mission_id = $missionID AND status = 'open' ORDER BY created_at",
      )
      .all({ $missionID: missionID }) as SqlRow[];
  }

  private latestVerificationIssues(missionID: string): GateCheckResult["verification_issues"] {
    const rows = this.db
      .query(
        `SELECT task_id, verdict, gate_status, report_json FROM verification_results
         WHERE mission_id = $missionID
         ORDER BY created_at DESC, id DESC`,
      )
      .all({ $missionID: missionID }) as SqlRow[];
    const issues: GateCheckResult["verification_issues"] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const key = typeof row.task_id === "string" ? row.task_id : "__mission__";
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const report = decodeJson<Record<string, unknown>>(row.report_json, {});
      if (row.verdict === "request-changes" || row.gate_status === "fail") {
        issues.push({
          ...(typeof row.task_id === "string" ? { task_id: row.task_id } : {}),
          issue: "Latest verifier report requested changes or failed the gate.",
        });
      }
      const reportIssues = Array.isArray(report.issues) ? report.issues : [];
      for (const issue of reportIssues) {
        if (!issue || typeof issue !== "object") continue;
        const severity = (issue as Record<string, unknown>).severity;
        if (severity === "critical") {
          issues.push({
            ...(typeof row.task_id === "string" ? { task_id: row.task_id } : {}),
            issue: String((issue as Record<string, unknown>).issue ?? "critical verifier issue"),
          });
        }
      }
    }
    return issues;
  }
}

function mergeCriteria(
  existing: AcceptanceCriterion[],
  updates: AcceptanceCriterion[],
): AcceptanceCriterion[] {
  const merged = [...existing];
  for (const update of normalizeCriteria(updates)) {
    const index = merged.findIndex((item) => item.criterion === update.criterion);
    if (index >= 0) {
      merged[index] = { ...merged[index], ...update };
    } else {
      merged.push(update);
    }
  }
  return merged;
}

function decodeTasksToReopen(report: Record<string, unknown>): string[] {
  return asStringArray(report.tasks_to_reopen);
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function buildGateActions(
  openTasks: TaskRecord[],
  blockers: SqlRow[],
  missingEvidence: GateCheckResult["missing_evidence"],
  verificationIssues: GateCheckResult["verification_issues"],
): string[] {
  const actions: string[] = [];
  if (openTasks.length > 0) {
    actions.push(`Resolve ${openTasks.length} open task(s).`);
  }
  if (blockers.length > 0) {
    actions.push(`Batch ${blockers.length} unresolved blocker(s) for the user or resolve them.`);
  }
  if (missingEvidence.length > 0) {
    actions.push(`Collect evidence for ${missingEvidence.length} missing criterion/check(s).`);
  }
  if (verificationIssues.length > 0) {
    actions.push(`Clear ${verificationIssues.length} verifier issue(s).`);
  }
  return actions;
}

export function createOrchestratorLedger(
  projectDirectory: string,
  config: HarnessConfig,
): OrchestratorLedger {
  const dbPath = resolveLedgerPath(projectDirectory, config);
  return new OrchestratorLedger(dbPath);
}
