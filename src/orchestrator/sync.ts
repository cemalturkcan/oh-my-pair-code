import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";
import type { HarnessConfig } from "../types";
import { DEFAULT_LEDGER_FILENAME, defaultUserStateDirectory, OrchestratorLedger, resolveLedgerPath } from "./ledger";

export type LedgerRow = Record<string, unknown> & { id?: string };

export type LedgerSnapshot = Record<string, LedgerRow[]>;

export type LedgerReconcileConflict = {
  table: string;
  id?: string;
  field?: string;
  reason: string;
  local?: unknown;
  remote?: unknown;
  resolution_options: string[];
};

export type LedgerReconcileResult = {
  ok: true;
  merged: LedgerSnapshot;
  conflicts: LedgerReconcileConflict[];
  warnings: string[];
  stats: {
    tables: number;
    local_rows: number;
    remote_rows: number;
    merged_rows: number;
    auto_merged_rows: number;
    deduped_rows: number;
    forked_rows: number;
  };
};

export type LedgerSqliteReconcileOptions = {
  local_db_path: string;
  remote_db_path: string;
  output_db_path?: string;
  dry_run?: boolean;
};

export type LedgerSqliteReconcileResult = LedgerReconcileResult & {
  source_files: {
    local: string;
    remote: string;
    output?: string;
  };
  output: {
    mode: "dry_run" | "written";
    db_path?: string;
    wrote_output: boolean;
  };
  suggested_files: {
    local_snapshot: string;
    remote_snapshot: string;
    merged_snapshot: string;
    conflicts_report: string;
  };
};

export type LedgerSyncPhase =
  | "manual"
  | "session_start"
  | "checkpoint"
  | "session_end"
  | "crash_recovery";

export type LedgerSyncPlan = {
  ok: true;
  status: "disabled" | "not_configured" | "ready" | "missing_repo";
  phase: LedgerSyncPhase;
  enabled: boolean;
  repo?: string;
  path?: string;
  branch: string;
  configured_from: string[];
  lifecycle_policy: {
    session_start: "auto_pull_plan" | "disabled";
    checkpoint: "status_only_exit_push_handles_git" | "disabled";
    session_end: "best_effort_push_plan" | "disabled";
    crash_recovery: "pull_then_reconcile" | "disabled";
  };
  safe_commands: string[];
  warnings: string[];
  next_actions: string[];
};

export type LedgerSyncAction = "start_pull" | "exit_push";

export type LedgerSyncCommandResult = {
  ok: boolean;
  status?: number | null;
  stdout?: string;
  stderr?: string;
  error?: string;
};

export type LedgerSyncRunner = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<LedgerSyncCommandResult> | LedgerSyncCommandResult;

export type LedgerSyncExecutionResult = {
  ok: true;
  action: LedgerSyncAction;
  skipped: boolean;
  changed: boolean;
  warnings: string[];
  commands: string[][];
  checkpoint_path?: string;
};

const SYNC_GIT_TIMEOUT_MS = 15_000;

const SYNC_GIT_ENV: NodeJS.ProcessEnv = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_EDITOR: "true",
  GIT_PAGER: "cat",
  PAGER: "cat",
  GCM_INTERACTIVE: "never",
};

const APPEND_ONLY_TABLES = new Set([
  "artifacts",
  "context_bundles",
  "decisions",
  "acceptance",
  "evidence",
]);

const SQLITE_INTERNAL_TABLE_PREFIX = "sqlite_";

function timestampSlug(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function suggestedSnapshotFiles(timestamp = timestampSlug()) {
  return {
    local_snapshot: `local.${timestamp}.sqlite`,
    remote_snapshot: `remote.${timestamp}.sqlite`,
    merged_snapshot: `merged.${timestamp}.sqlite`,
    conflicts_report: `conflicts.${timestamp}.json`,
  };
}

function assertReadableSqliteSnapshot(path: string, label: string): string {
  const resolved = resolve(path);
  if (!existsSync(resolved)) {
    throw new Error(`${label} SQLite snapshot does not exist: ${resolved}`);
  }
  return resolved;
}

function listUserTables(db: Database): string[] {
  return db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => String((row as Record<string, unknown>).name))
    .filter((name) => !name.startsWith(SQLITE_INTERNAL_TABLE_PREFIX));
}

function listTableColumns(db: Database, table: string): string[] {
  return db
    .query(`PRAGMA table_info(${JSON.stringify(table)})`)
    .all()
    .map((row) => String((row as Record<string, unknown>).name));
}

function exportSqliteSnapshot(dbPath: string): LedgerSnapshot {
  const db = new Database(dbPath, { readonly: true });
  try {
    const snapshot: LedgerSnapshot = {};
    for (const table of listUserTables(db)) {
      snapshot[table] = db.query(`SELECT * FROM ${JSON.stringify(table)}`).all() as LedgerRow[];
    }
    return snapshot;
  } finally {
    db.close();
  }
}

function writeSqliteSnapshot(dbPath: string, snapshot: LedgerSnapshot): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  new OrchestratorLedger(dbPath);
  const db = new Database(dbPath);
  try {
    db.exec("PRAGMA foreign_keys = OFF");
    const tables = listUserTables(db);
    db.transaction(() => {
      for (const table of [...tables].reverse()) {
        db.query(`DELETE FROM ${JSON.stringify(table)}`).run();
      }
      for (const table of tables) {
        const rows = snapshot[table] ?? [];
        if (rows.length === 0) continue;
        const columns = listTableColumns(db, table);
        const writableColumns = columns.filter((column) => rows.some((row) => column in row));
        if (writableColumns.length === 0) continue;
        const sql = `INSERT OR REPLACE INTO ${JSON.stringify(table)} (${writableColumns.map((column) => JSON.stringify(column)).join(", ")}) VALUES (${writableColumns.map((column) => `$${column}`).join(", ")})`;
        const insert = db.query(sql);
        for (const row of rows) {
          insert.run(Object.fromEntries(writableColumns.map((column) => [`$${column}`, row[column] ?? null])) as any);
        }
      }
    })();
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
    db.close();
  }
}

const SAFE_TASK_STATUS_ORDER = [
  "reopened",
  "needs_verification",
  "blocked",
  "in_progress",
  "pending",
  "done",
] as const;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function rowHash(row: LedgerRow): string {
  return createHash("sha256").update(stableJson(row)).digest("hex").slice(0, 12);
}

function cloneRow(row: LedgerRow): LedgerRow {
  return JSON.parse(JSON.stringify(row)) as LedgerRow;
}

function rowsEqual(a: LedgerRow, b: LedgerRow): boolean {
  return stableJson(a) === stableJson(b);
}

function dedupeKey(table: string, row: LedgerRow): string {
  if (row.id) return `id:${row.id}`;
  const contentFields = ["mission_id", "project_id", "task_id", "type", "title", "content", "created_by", "created_at"];
  const compact = Object.fromEntries(contentFields.filter((field) => field in row).map((field) => [field, row[field]]));
  return `content:${table}:${rowHash(compact)}`;
}

function forkRemoteRow(row: LedgerRow, source = "remote"): LedgerRow {
  const copy = cloneRow(row);
  const id = typeof copy.id === "string" && copy.id ? copy.id : "row";
  copy.id = `${id}@${source}-${rowHash(row)}`;
  copy.sync_source = source;
  copy.sync_original_id = id;
  return copy;
}

function withLatestTimestamp(local: LedgerRow, remote: LedgerRow): LedgerRow {
  const localTime = Date.parse(String(local.updated_at ?? local.created_at ?? ""));
  const remoteTime = Date.parse(String(remote.updated_at ?? remote.created_at ?? ""));
  if (Number.isFinite(localTime) && Number.isFinite(remoteTime)) {
    return remoteTime > localTime ? cloneRow(remote) : cloneRow(local);
  }
  return stableJson(remote) > stableJson(local) ? cloneRow(remote) : cloneRow(local);
}

function safeTaskMerge(local: LedgerRow, remote: LedgerRow): { row?: LedgerRow; conflict?: LedgerReconcileConflict } {
  const localStatus = String(local.status ?? "");
  const remoteStatus = String(remote.status ?? "");
  if (localStatus === remoteStatus) return { row: withLatestTimestamp(local, remote) };
  if ((localStatus === "done" && ["reopened", "needs_verification"].includes(remoteStatus)) || (remoteStatus === "done" && ["reopened", "needs_verification"].includes(localStatus))) {
    const safer = SAFE_TASK_STATUS_ORDER.indexOf(localStatus as any) <= SAFE_TASK_STATUS_ORDER.indexOf(remoteStatus as any) ? local : remote;
    return { row: { ...withLatestTimestamp(local, remote), status: safer.status } };
  }
  if ((localStatus === "done" && remoteStatus === "cancelled") || (remoteStatus === "done" && localStatus === "cancelled")) {
    return { conflict: { table: "tasks", id: String(local.id ?? remote.id ?? ""), field: "status", reason: "done_cancelled_conflict", local: local.status, remote: remote.status, resolution_options: ["keep_local", "keep_remote", "reopen_for_verification", "mark_cancelled_with_decision"] } };
  }
  return { row: SAFE_TASK_STATUS_ORDER.indexOf(localStatus as any) <= SAFE_TASK_STATUS_ORDER.indexOf(remoteStatus as any) ? cloneRow(local) : cloneRow(remote) };
}

function safeMissionMerge(local: LedgerRow, remote: LedgerRow): LedgerRow {
  const statuses = new Set([String(local.status ?? ""), String(remote.status ?? "")]);
  if (statuses.has("blocked")) return { ...withLatestTimestamp(local, remote), status: "blocked" };
  if (statuses.has("active")) return { ...withLatestTimestamp(local, remote), status: "active" };
  if (statuses.has("done") && statuses.has("cancelled")) return { ...withLatestTimestamp(local, remote), status: "blocked" };
  return withLatestTimestamp(local, remote);
}

function safeBlockerMerge(local: LedgerRow, remote: LedgerRow): LedgerRow {
  const required = Boolean(local.required_user_input) || Boolean(remote.required_user_input);
  const localOpen = local.status !== "resolved";
  const remoteOpen = remote.status !== "resolved";
  if (required || localOpen || remoteOpen) return { ...withLatestTimestamp(local, remote), status: "open", required_user_input: required ? 1 : 0, resolved_at: null };
  return withLatestTimestamp(local, remote);
}

function safeVerificationMerge(local: LedgerRow, remote: LedgerRow): LedgerRow {
  const hasRequestChanges = [local.verdict, remote.verdict].includes("request-changes");
  const hasFail = [local.gate_status, remote.gate_status].includes("fail");
  if (hasRequestChanges || hasFail) return { ...withLatestTimestamp(local, remote), verdict: "request-changes", gate_status: "fail" };
  return withLatestTimestamp(local, remote);
}

function remoteRuntimeRowForLocalMerge(table: string, row: LedgerRow): LedgerRow {
  const copy = cloneRow(row);
  if (table === "sessions" && ["active", "idle"].includes(String(copy.status))) {
    copy.status = "ended";
    copy.ended_at = copy.ended_at ?? copy.updated_at ?? new Date(0).toISOString();
    copy.metadata_json = JSON.stringify({ sync_remote_runtime_closed: true });
  }
  return copy;
}

function mergeSameId(table: string, local: LedgerRow, remote: LedgerRow): { rows: LedgerRow[]; conflicts: LedgerReconcileConflict[]; forked: number } {
  if (rowsEqual(local, remote)) return { rows: [cloneRow(local)], conflicts: [], forked: 0 };
  if (table === "tasks") {
    const merged = safeTaskMerge(local, remote);
    if (merged.row) return { rows: [merged.row], conflicts: [], forked: 0 };
    return { rows: [cloneRow(local), forkRemoteRow(remote)], conflicts: [merged.conflict!], forked: 1 };
  }
  if (table === "missions") return { rows: [safeMissionMerge(local, remote)], conflicts: [], forked: 0 };
  if (table === "blockers") return { rows: [safeBlockerMerge(local, remote)], conflicts: [], forked: 0 };
  if (table === "verification_results") return { rows: [safeVerificationMerge(local, remote)], conflicts: [], forked: 0 };
  if (table === "sessions") return { rows: [cloneRow(local), forkRemoteRow(remoteRuntimeRowForLocalMerge(table, remote))], conflicts: [], forked: 1 };
  if (APPEND_ONLY_TABLES.has(table)) return { rows: [cloneRow(local), forkRemoteRow(remote)], conflicts: [], forked: 1 };
  return {
    rows: [cloneRow(local), forkRemoteRow(remote)],
    forked: 1,
    conflicts: [{ table, id: String(local.id ?? remote.id ?? ""), reason: "same_id_different_content", local, remote, resolution_options: ["keep_local", "keep_remote", "keep_both_forked", "manual_merge"] }],
  };
}

export function reconcileLedgerSnapshots(local: LedgerSnapshot, remote: LedgerSnapshot): LedgerReconcileResult {
  const tables = [...new Set([...Object.keys(local), ...Object.keys(remote)])].sort();
  const merged: LedgerSnapshot = {};
  const conflicts: LedgerReconcileConflict[] = [];
  let autoMergedRows = 0;
  let dedupedRows = 0;
  let forkedRows = 0;

  for (const table of tables) {
    const output: LedgerRow[] = [];
    const localRows = (local[table] ?? []).map(cloneRow);
    const remoteRows = (remote[table] ?? []).map((row) => (table === "sessions" ? remoteRuntimeRowForLocalMerge(table, row) : cloneRow(row)));
    const localByKey = new Map(localRows.map((row) => [dedupeKey(table, row), row]));
    const remoteByKey = new Map(remoteRows.map((row) => [dedupeKey(table, row), row]));
    const keys = [...new Set([...localByKey.keys(), ...remoteByKey.keys()])].sort();

    for (const key of keys) {
      const localRow = localByKey.get(key);
      const remoteRow = remoteByKey.get(key);
      if (localRow && !remoteRow) output.push(cloneRow(localRow));
      else if (!localRow && remoteRow) output.push(cloneRow(remoteRow));
      else if (localRow && remoteRow) {
        const result = mergeSameId(table, localRow, remoteRow);
        output.push(...result.rows);
        conflicts.push(...result.conflicts);
        forkedRows += result.forked;
        if (rowsEqual(localRow, remoteRow)) dedupedRows += 1;
        else autoMergedRows += result.conflicts.length === 0 ? 1 : 0;
      }
    }
    merged[table] = output.sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
  }

  const localCount = Object.values(local).reduce((sum, rows) => sum + rows.length, 0);
  const remoteCount = Object.values(remote).reduce((sum, rows) => sum + rows.length, 0);
  const mergedCount = Object.values(merged).reduce((sum, rows) => sum + rows.length, 0);
  return {
    ok: true,
    merged,
    conflicts,
    warnings: [
      "Reconcile is side-effect-free against input snapshots; write merged output only through an explicit caller-owned step.",
      "Remote active sessions are ended in local merge plans.",
      ...(conflicts.length ? ["True conflicts require an explicit operator choice; no conflicting row was silently overwritten."] : []),
    ],
    stats: { tables: tables.length, local_rows: localCount, remote_rows: remoteCount, merged_rows: mergedCount, auto_merged_rows: autoMergedRows, deduped_rows: dedupedRows, forked_rows: forkedRows },
  };
}

export function reconcileLedgerSqliteSnapshots(options: LedgerSqliteReconcileOptions): LedgerSqliteReconcileResult {
  const localPath = assertReadableSqliteSnapshot(options.local_db_path, "local");
  const remotePath = assertReadableSqliteSnapshot(options.remote_db_path, "remote");
  const outputPath = options.output_db_path ? resolve(options.output_db_path) : undefined;
  const dryRun = options.dry_run !== false || !outputPath;

  if (outputPath && (outputPath === localPath || outputPath === remotePath)) {
    throw new Error("Refusing to write merged output over an input snapshot; choose a distinct explicit output_db_path.");
  }

  const local = exportSqliteSnapshot(localPath);
  const remote = exportSqliteSnapshot(remotePath);
  const result = reconcileLedgerSnapshots(local, remote);

  if (!dryRun && !outputPath) {
    throw new Error("output_db_path is required when dry_run is false.");
  }
  if (!dryRun && outputPath) {
    writeSqliteSnapshot(outputPath, result.merged);
  }

  return {
    ...result,
    warnings: [
      ...result.warnings,
      "SQLite file reconcile opens local and remote snapshots read-only and never modifies either input file.",
      dryRun
        ? "Dry run only: no merged SQLite output was written. Pass dry_run=false with an explicit distinct output_db_path to materialize merged.sqlite."
        : "Merged SQLite output was written only to the explicit output_db_path; replace the active DB manually only after reviewing conflicts.",
    ],
    source_files: {
      local: localPath,
      remote: remotePath,
      ...(outputPath ? { output: outputPath } : {}),
    },
    output: {
      mode: dryRun ? "dry_run" : "written",
      ...(outputPath ? { db_path: outputPath } : {}),
      wrote_output: !dryRun,
    },
    suggested_files: suggestedSnapshotFiles(),
  };
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.map((value) => value?.trim()).find(Boolean);
}

export function isGitRemoteUrl(input: string): boolean {
  const value = input.trim();
  return /^(?:https?|ssh|git):\/\//i.test(value) || /^git@[^\s:]+:[^\s]+$/i.test(value);
}

export function defaultLocalSyncPath(): string {
  return join(defaultUserStateDirectory(), "sync");
}

function resolveLocalSyncPath(projectDirectory: string, path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(projectDirectory, path);
}

export function buildLedgerSyncPlan(
  projectDirectory: string,
  config: HarnessConfig,
  phase: LedgerSyncPhase = "manual",
): LedgerSyncPlan {
  const sync = config.orchestration?.sync ?? {};
  const envRepo = firstNonEmpty(process.env.OPENCODE_PAIR_SYNC_REPO);
  const envPath = firstNonEmpty(process.env.OPENCODE_PAIR_SYNC_PATH);
  const configuredRepo = firstNonEmpty(sync.repo, sync.url, envRepo);
  const configuredPath = firstNonEmpty(sync.path, envPath);
  const repoIsUrl = configuredRepo ? isGitRemoteUrl(configuredRepo) : false;
  const pathInput = configuredPath ?? (configuredRepo && !repoIsUrl ? configuredRepo : undefined);
  const localSyncPath = pathInput
    ? resolveLocalSyncPath(projectDirectory, pathInput)
    : configuredRepo
      ? defaultLocalSyncPath()
      : undefined;
  const configuredFrom = [
    ...(sync.repo ? ["orchestration.sync.repo"] : []),
    ...(sync.path ? ["orchestration.sync.path"] : []),
    ...(sync.url ? ["orchestration.sync.url"] : []),
    ...(envRepo ? ["OPENCODE_PAIR_SYNC_REPO"] : []),
    ...(envPath ? ["OPENCODE_PAIR_SYNC_PATH"] : []),
  ];
  const enabled = sync.enabled === true || Boolean(configuredRepo || configuredPath || envRepo || envPath);
  const branch = firstNonEmpty(process.env.OPENCODE_PAIR_SYNC_BRANCH, sync.branch) ?? "main";

  const lifecycle_policy: LedgerSyncPlan["lifecycle_policy"] = enabled
    ? {
        session_start: "auto_pull_plan",
        checkpoint: "status_only_exit_push_handles_git",
        session_end: "best_effort_push_plan",
        crash_recovery: "pull_then_reconcile",
      }
    : {
        session_start: "disabled",
        checkpoint: "disabled",
        session_end: "disabled",
        crash_recovery: "disabled",
      };

  const base: Omit<LedgerSyncPlan, "status" | "safe_commands" | "warnings" | "next_actions"> = {
    ok: true,
    phase,
    enabled,
    repo: configuredRepo,
    path: localSyncPath,
    branch,
    configured_from: configuredFrom,
    lifecycle_policy,
  };

  if (!enabled) {
    return {
      ...base,
      status: "disabled",
      safe_commands: [],
      warnings: ["Ledger sync is disabled; normal ledger operations continue locally."],
      next_actions: ["Set orchestration.sync.enabled=true and configure a private repo/path in user config or OPENCODE_PAIR_SYNC_REPO."],
    };
  }

  if (!configuredRepo && !localSyncPath) {
    return {
      ...base,
      status: "not_configured",
      safe_commands: [],
      warnings: ["Ledger sync is enabled but no private sync repo/path is configured."],
      next_actions: ["Configure orchestration.sync.repo/path/url in ~/.config/opencode/opencode-pair.jsonc or set OPENCODE_PAIR_SYNC_REPO."],
    };
  }

  const repoPath = localSyncPath ?? defaultLocalSyncPath();
  const repoExists = existsSync(repoPath);
  const commands = [
    "Optional recovery/debug templates; normal configured lifecycle is automatic start pull and clean-exit push.",
    `git -C ${JSON.stringify(repoPath)} status --short --branch`,
    `git -C ${JSON.stringify(repoPath)} pull --ff-only origin ${branch}`,
    "Close OpenCode so SQLite WAL state checkpoints before commit/push.",
    `git -C ${JSON.stringify(repoPath)} add orchestrator.sqlite`,
    `git -C ${JSON.stringify(repoPath)} commit -m "checkpoint ledger"`,
    `git -C ${JSON.stringify(repoPath)} push origin ${branch}`,
  ];

  return {
    ...base,
    repo: configuredRepo && repoIsUrl ? configuredRepo : repoPath,
    path: repoPath,
    status: repoExists ? "ready" : "missing_repo",
    safe_commands: commands,
    warnings: [
      "This status helper is side-effect-free: it does not run git pull, commit, push, reset, checkout, or DB writes.",
      "Configured ledger sync runs automatically: session start pulls best-effort and clean session exit checkpoints, commits, and pushes best-effort.",
      "Checkpoint phase is status-only/no git mutation; clean session exit handles checkpoint, commit, and push.",
      "Treat the raw SQLite ledger as single-writer state; do not merge SQLite/WAL/SHM conflicts by hand.",
      ...(repoExists ? [] : ["Configured sync repo/path does not exist on this machine; ledger sync is skipped."]),
    ],
    next_actions: repoExists
      ? ["OpenCode/session start runs pull --ff-only automatically; clean session exit checkpoints orchestrator.sqlite and pushes when changed."]
      : ["Clone or create the private sync repo at the configured path; installer bootstrap can prepare an empty origin/main automatically."],
  };
}

function defaultSyncRunner(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): LedgerSyncCommandResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || undefined,
    stderr: result.stderr || undefined,
    error: result.error?.message,
  };
}

function compactGitFailure(args: string[], result: LedgerSyncCommandResult): string {
  const detail = result.error || result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status ?? "unknown"}`;
  return `git ${args.join(" ")} failed non-blocking: ${detail}`;
}

async function runSyncGit(repoPath: string, args: string[], runner: LedgerSyncRunner): Promise<LedgerSyncCommandResult> {
  const env = { ...process.env, ...SYNC_GIT_ENV };
  return await runner("git", args, { cwd: repoPath, env, timeoutMs: SYNC_GIT_TIMEOUT_MS });
}

function ensureCheckpointedLedger(projectDirectory: string, config: HarnessConfig, syncPath: string): string {
  const source = resolveLedgerPath(projectDirectory, config);
  mkdirSync(dirname(source), { recursive: true });
  new OrchestratorLedger(source);
  const db = new Database(source);
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
  const target = join(syncPath, DEFAULT_LEDGER_FILENAME);
  copyFileSync(source, target);
  return target;
}

function isSyncGitCheckout(syncPath: string): boolean {
  return existsSync(join(syncPath, ".git"));
}

export async function runLedgerSyncStartPull(
  projectDirectory: string,
  config: HarnessConfig,
  runner: LedgerSyncRunner = defaultSyncRunner,
): Promise<LedgerSyncExecutionResult> {
  const plan = buildLedgerSyncPlan(projectDirectory, config, "session_start");
  const warnings = [...plan.warnings];
  const commands: string[][] = [];
  if (!plan.enabled || plan.status !== "ready" || !plan.path) {
    return { ok: true, action: "start_pull", skipped: true, changed: false, warnings, commands };
  }
  if (!isSyncGitCheckout(plan.path)) {
    warnings.push(`Configured sync path is not a git checkout; ledger sync skipped: ${plan.path}`);
    return { ok: true, action: "start_pull", skipped: true, changed: false, warnings, commands };
  }

  const args = ["pull", "--ff-only", "origin", plan.branch];
  commands.push(["git", ...args]);
  const result = await runSyncGit(plan.path, args, runner);
  if (!result.ok) warnings.push(compactGitFailure(args, result));
  return { ok: true, action: "start_pull", skipped: false, changed: result.ok, warnings, commands };
}

export async function runLedgerSyncExitPush(
  projectDirectory: string,
  config: HarnessConfig,
  runner: LedgerSyncRunner = defaultSyncRunner,
): Promise<LedgerSyncExecutionResult> {
  const plan = buildLedgerSyncPlan(projectDirectory, config, "session_end");
  const warnings = [...plan.warnings];
  const commands: string[][] = [];
  if (!plan.enabled || plan.status !== "ready" || !plan.path) {
    return { ok: true, action: "exit_push", skipped: true, changed: false, warnings, commands };
  }
  if (!isSyncGitCheckout(plan.path)) {
    warnings.push(`Configured sync path is not a git checkout; ledger sync skipped: ${plan.path}`);
    return { ok: true, action: "exit_push", skipped: true, changed: false, warnings, commands };
  }

  const checkpointPath = ensureCheckpointedLedger(projectDirectory, config, plan.path);
  const addArgs = ["add", DEFAULT_LEDGER_FILENAME];
  commands.push(["git", ...addArgs]);
  const add = await runSyncGit(plan.path, addArgs, runner);
  if (!add.ok) {
    warnings.push(compactGitFailure(addArgs, add));
    return { ok: true, action: "exit_push", skipped: false, changed: false, warnings, commands, checkpoint_path: checkpointPath };
  }

  const diffArgs = ["diff", "--cached", "--quiet", "--", DEFAULT_LEDGER_FILENAME];
  commands.push(["git", ...diffArgs]);
  const diff = await runSyncGit(plan.path, diffArgs, runner);
  if (diff.ok) {
    return { ok: true, action: "exit_push", skipped: false, changed: false, warnings, commands, checkpoint_path: checkpointPath };
  }
  if (diff.status !== 1) {
    warnings.push(compactGitFailure(diffArgs, diff));
    return { ok: true, action: "exit_push", skipped: false, changed: false, warnings, commands, checkpoint_path: checkpointPath };
  }

  const commitArgs = ["commit", "-m", "checkpoint ledger"];
  commands.push(["git", ...commitArgs]);
  const commit = await runSyncGit(plan.path, commitArgs, runner);
  if (!commit.ok) {
    warnings.push(compactGitFailure(commitArgs, commit));
    return { ok: true, action: "exit_push", skipped: false, changed: false, warnings, commands, checkpoint_path: checkpointPath };
  }

  const pushArgs = ["push", "origin", plan.branch];
  commands.push(["git", ...pushArgs]);
  const push = await runSyncGit(plan.path, pushArgs, runner);
  if (!push.ok) warnings.push(compactGitFailure(pushArgs, push));
  return { ok: true, action: "exit_push", skipped: false, changed: commit.ok && push.ok, warnings, commands, checkpoint_path: checkpointPath };
}
