import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OrchestratorLedger, defaultUserStateDirectory, getMachineId, resolveLedgerPath } from "../orchestrator/ledger";
import { buildGuardPreflight, createOrchestrationTools } from "../orchestrator/tools";
import { buildLedgerSyncPlan, reconcileLedgerSnapshots, reconcileLedgerSqliteSnapshots, runLedgerSyncExitPush, runLedgerSyncStartPull, type LedgerSyncRunner } from "../orchestrator/sync";

function withLedger(fn: (ledger: OrchestratorLedger, root: string) => void) {
  const root = join(
    tmpdir(),
    `opencode-pair-ledger-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(root, { recursive: true });
  try {
    fn(new OrchestratorLedger(join(root, "state", "orchestrator.sqlite")), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function withLedgerAsync(fn: (ledger: OrchestratorLedger, root: string) => Promise<void>) {
  const root = join(
    tmpdir(),
    `opencode-pair-ledger-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(root, { recursive: true });
  try {
    await fn(new OrchestratorLedger(join(root, "state", "orchestrator.sqlite")), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function runTool(
  tools: ReturnType<typeof createOrchestrationTools>,
  name: keyof ReturnType<typeof createOrchestrationTools>,
  args: Record<string, unknown>,
  context: Record<string, unknown> = {},
) {
  const result = await (tools[name] as any).execute(args, {
    sessionID: "oc-test-session",
    agent: "implementation-engineer",
    metadata: () => undefined,
    ...context,
  });
  return JSON.parse(result);
}

function fileHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function runGit(root: string, args: string[]) {
  const result = Bun.spawnSync({ cmd: ["git", ...args], cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", PAGER: "cat" } });
  if (!result.success) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
}

describe("orchestrator ledger", () => {
  it("uses a user-level SQLite path by default", () => {
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = "/tmp/opencode-pair-state-test";
    try {
      expect(defaultUserStateDirectory()).toBe("/tmp/opencode-pair-state-test/opencode-pair");
      expect(resolveLedgerPath("/project", {})).toBe(
        "/tmp/opencode-pair-state-test/opencode-pair/orchestrator.sqlite",
      );
    } finally {
      if (previous === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previous;
    }
    expect(
      resolveLedgerPath("/project", {
        orchestration: { ledger_path: ".custom/mission.sqlite" },
      }),
    ).toBe("/project/.custom/mission.sqlite");
  });

  it("builds safe side-effect-free sync plans from config", async () => {
    const root = join(tmpdir(), `opencode-pair-sync-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(root, "sync-repo"), { recursive: true });
    try {
      const disabled = buildLedgerSyncPlan(root, {}, "manual");
      expect(disabled.status).toBe("disabled");
      expect(disabled.safe_commands).toEqual([]);

      const ready = buildLedgerSyncPlan(root, {
        orchestration: {
          sync: {
            enabled: true,
            repo: "sync-repo",
            branch: "ledger",
          },
        },
      }, "session_start");
      expect(ready.status).toBe("ready");
      expect(ready.repo).toBe(join(root, "sync-repo"));
      expect(ready).not.toHaveProperty("manual_only");
      expect(ready.lifecycle_policy.session_start).toBe("auto_pull_plan");
      expect(ready.lifecycle_policy.checkpoint).toBe("status_only_exit_push_handles_git");
      expect(ready.lifecycle_policy.session_end).toBe("best_effort_push_plan");
      expect(ready.safe_commands.join("\n")).toContain("pull --ff-only origin ledger");
      expect(ready.safe_commands.join("\n")).toContain("Optional recovery/debug templates");
      expect(ready.warnings.join(" ")).toContain("Checkpoint phase is status-only/no git mutation");
      expect(ready.warnings.join(" ")).toContain("Configured ledger sync runs automatically");

      const missing = buildLedgerSyncPlan(root, {
        orchestration: { sync: { enabled: true, repo: "missing" } },
      });
      expect(missing.status).toBe("missing_repo");
      expect(missing.warnings.join(" ")).toContain("does not exist");

      const previousStateHome = process.env.XDG_STATE_HOME;
      process.env.XDG_STATE_HOME = join(root, "user-state");
      try {
        const urlPlan = buildLedgerSyncPlan(root, {
          orchestration: {
            sync: {
              enabled: true,
              repo: "https://github.com/cemalturkcan/opencode-pair-state.git",
            },
          },
        });
        expect(urlPlan.repo).toBe("https://github.com/cemalturkcan/opencode-pair-state.git");
        expect(urlPlan.path).toBe(join(root, "user-state", "opencode-pair", "sync"));
        expect(urlPlan.path).not.toContain("https:");
        expect(urlPlan.safe_commands.join("\n")).toContain(join(root, "user-state", "opencode-pair", "sync"));
        expect(urlPlan.safe_commands.join("\n")).not.toContain("github.com/cemalturkcan");
      } finally {
        if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = previousStateHome;
      }

      await withLedgerAsync(async (ledger) => {
        const tools = createOrchestrationTools(ledger, {
          orchestration: { sync: { enabled: true, repo: "sync-repo" } },
        }, root);
        const result = await runTool(tools, "orchestrator_sync_status", { phase: "checkpoint" });
        expect(result.sync.status).toBe("ready");
        expect(result.sync.phase).toBe("checkpoint");
        expect(result.sync.lifecycle_policy.checkpoint).toBe("status_only_exit_push_handles_git");
        expect(result.sync.warnings.join(" ")).toContain("clean session exit handles checkpoint, commit, and push");
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs automatic start pull with bounded non-interactive git env", async () => {
    const root = join(tmpdir(), `opencode-pair-sync-pull-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const checkout = join(root, "sync-repo");
    mkdirSync(join(checkout, ".git"), { recursive: true });
    const calls: Array<{ command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }> = [];
    const runner: LedgerSyncRunner = async (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd, env: options.env, timeoutMs: options.timeoutMs });
      return { ok: true, status: 0 };
    };
    try {
      const result = await runLedgerSyncStartPull(root, { orchestration: { sync: { enabled: true, path: checkout, branch: "ledger" } } }, runner);
      expect(result.skipped).toBe(false);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.args).toEqual(["pull", "--ff-only", "origin", "ledger"]);
      expect(calls[0]?.cwd).toBe(checkout);
      expect(calls[0]?.env.GIT_TERMINAL_PROMPT).toBe("0");
      expect(calls[0]?.env.GIT_EDITOR).toBe("true");
      expect(calls[0]?.env.GIT_PAGER).toBe("cat");
      expect(calls[0]?.timeoutMs).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips automatic sync without throwing for missing or non-git checkout", async () => {
    const root = join(tmpdir(), `opencode-pair-sync-missing-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const nonGit = join(root, "not-git");
    mkdirSync(nonGit, { recursive: true });
    let calls = 0;
    const runner: LedgerSyncRunner = async () => { calls += 1; return { ok: true }; };
    try {
      const missing = await runLedgerSyncStartPull(root, { orchestration: { sync: { enabled: true, path: join(root, "missing") } } }, runner);
      const invalid = await runLedgerSyncStartPull(root, { orchestration: { sync: { enabled: true, path: nonGit } } }, runner);
      expect(missing.skipped).toBe(true);
      expect(invalid.skipped).toBe(true);
      expect(invalid.warnings.join(" ")).toContain("not a git checkout");
      expect(calls).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("checkpoints ledger sqlite and pushes on clean exit only when changed", async () => {
    const root = join(tmpdir(), `opencode-pair-sync-exit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const checkout = join(root, "sync-repo");
    const ledgerPath = join(root, "state", "orchestrator.sqlite");
    mkdirSync(join(checkout, ".git"), { recursive: true });
    const ledger = new OrchestratorLedger(ledgerPath);
    ledger.createMission({ title: "Mission", goal: "Goal" });
    const calls: string[][] = [];
    const runner: LedgerSyncRunner = async (_command, args) => {
      calls.push(args);
      if (args[0] === "diff") return { ok: false, status: 1 };
      return { ok: true, status: 0 };
    };
    try {
      const result = await runLedgerSyncExitPush(root, { orchestration: { ledger_path: ledgerPath, sync: { enabled: true, path: checkout, branch: "ledger" } } }, runner);
      expect(existsSync(join(checkout, "orchestrator.sqlite"))).toBe(true);
      expect(result.changed).toBe(true);
      expect(calls).toEqual([
        ["add", "orchestrator.sqlite"],
        ["diff", "--cached", "--quiet", "--", "orchestrator.sqlite"],
        ["commit", "-m", "checkpoint ledger"],
        ["push", "origin", "ledger"],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not commit or push when exit checkpoint has no staged changes", async () => {
    const root = join(tmpdir(), `opencode-pair-sync-noop-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const checkout = join(root, "sync-repo");
    mkdirSync(join(checkout, ".git"), { recursive: true });
    const calls: string[][] = [];
    const runner: LedgerSyncRunner = async (_command, args) => {
      calls.push(args);
      return { ok: true, status: 0 };
    };
    try {
      const result = await runLedgerSyncExitPush(root, { orchestration: { ledger_path: join(root, "state.sqlite"), sync: { enabled: true, path: checkout } } }, runner);
      expect(result.changed).toBe(false);
      expect(calls.map((args) => args[0])).toEqual(["add", "diff"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lets OPENCODE_PAIR_SYNC_BRANCH override configured sync branch", () => {
    const root = join(tmpdir(), `opencode-pair-sync-branch-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const previousBranch = process.env.OPENCODE_PAIR_SYNC_BRANCH;
    mkdirSync(join(root, "sync-repo"), { recursive: true });
    process.env.OPENCODE_PAIR_SYNC_BRANCH = "env-ledger";

    try {
      const plan = buildLedgerSyncPlan(root, {
        orchestration: {
          sync: {
            enabled: true,
            repo: "sync-repo",
            branch: "config-ledger",
          },
        },
      });

      expect(plan.status).toBe("ready");
      expect(plan.repo).toBe(join(root, "sync-repo"));
      expect(plan.branch).toBe("env-ledger");
      expect(plan.safe_commands.join("\n")).toContain("pull --ff-only origin env-ledger");
      expect(plan.safe_commands.join("\n")).toContain("push origin env-ledger");
    } finally {
      if (previousBranch === undefined) delete process.env.OPENCODE_PAIR_SYNC_BRANCH;
      else process.env.OPENCODE_PAIR_SYNC_BRANCH = previousBranch;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps sync repo URLs and local paths distinct for env/config plans", () => {
    const root = join(tmpdir(), `opencode-pair-sync-url-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const previousRepo = process.env.OPENCODE_PAIR_SYNC_REPO;
    const previousPath = process.env.OPENCODE_PAIR_SYNC_PATH;
    const previousStateHome = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = join(root, "state-home");
    process.env.OPENCODE_PAIR_SYNC_REPO = "git@example.com:private/ledger.git";
    delete process.env.OPENCODE_PAIR_SYNC_PATH;

    try {
      const envUrl = buildLedgerSyncPlan(root, {});
      expect(envUrl.enabled).toBe(true);
      expect(envUrl.repo).toBe("git@example.com:private/ledger.git");
      expect(envUrl.path).toBe(join(root, "state-home", "opencode-pair", "sync"));

      delete process.env.OPENCODE_PAIR_SYNC_REPO;
      process.env.OPENCODE_PAIR_SYNC_PATH = "relative-sync";
      const envPath = buildLedgerSyncPlan(root, {});
      expect(envPath.repo).toBe(join(root, "relative-sync"));
      expect(envPath.path).toBe(join(root, "relative-sync"));
      expect(envPath.configured_from).toContain("OPENCODE_PAIR_SYNC_PATH");
    } finally {
      if (previousRepo === undefined) delete process.env.OPENCODE_PAIR_SYNC_REPO;
      else process.env.OPENCODE_PAIR_SYNC_REPO = previousRepo;
      if (previousPath === undefined) delete process.env.OPENCODE_PAIR_SYNC_PATH;
      else process.env.OPENCODE_PAIR_SYNC_PATH = previousPath;
      if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previousStateHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reconciles non-conflicting snapshots without mutating inputs", async () => {
    const local = {
      missions: [{ id: "M-001", title: "Mission", goal: "Goal", status: "active", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" }],
      tasks: [{ id: "T-001", mission_id: "M-001", title: "Local", status: "pending", updated_at: "2026-01-01T00:00:00.000Z" }],
    };
    const remote = {
      tasks: [{ id: "T-002", mission_id: "M-001", title: "Remote", status: "in_progress", updated_at: "2026-01-02T00:00:00.000Z" }],
    };
    const before = JSON.stringify({ local, remote });

    const result = reconcileLedgerSnapshots(local, remote);
    expect(JSON.stringify({ local, remote })).toBe(before);
    expect(result.conflicts).toEqual([]);
    expect(result.merged.tasks.map((row) => row.id).sort()).toEqual(["T-001", "T-002"]);

    const root = join(tmpdir(), `opencode-pair-reconcile-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(root, { recursive: true });
    try {
      const tools = createOrchestrationTools(new OrchestratorLedger(join(root, "orchestrator.sqlite")));
      const plan = await runTool(tools, "orchestrator_sync_reconcile_plan", { local_snapshot: local, remote_snapshot: remote });
      expect(plan.ok).toBe(true);
      expect(plan.merged.tasks.length).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads SQLite ledger snapshots read-only and reports conflicts with snapshot names", () => {
    const root = join(tmpdir(), `opencode-pair-sqlite-reconcile-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(root, { recursive: true });
    const localPath = join(root, "local.sqlite");
    const remotePath = join(root, "remote.sqlite");
    try {
      new OrchestratorLedger(localPath);
      new OrchestratorLedger(remotePath);
      const localDb = new Database(localPath);
      const remoteDb = new Database(remotePath);
      localDb.query("INSERT INTO missions (id, title, goal, status, created_at, updated_at) VALUES ('M-001', 'Mission', 'Goal', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')").run();
      localDb.query("INSERT INTO tasks (id, mission_id, title, type, assigned_agent, status, priority, created_at, updated_at) VALUES ('T-001', 'M-001', 'Task', 'implementation', 'implementation-engineer', 'done', 'high', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')").run();
      remoteDb.query("INSERT INTO missions (id, title, goal, status, created_at, updated_at) VALUES ('M-001', 'Mission', 'Goal', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')").run();
      remoteDb.query("INSERT INTO tasks (id, mission_id, title, type, assigned_agent, status, priority, created_at, updated_at) VALUES ('T-001', 'M-001', 'Task', 'implementation', 'implementation-engineer', 'cancelled', 'high', '2026-01-01T00:00:00.000Z', '2026-01-03T00:00:00.000Z')").run();
      localDb.close();
      remoteDb.close();

      const before = { local: fileHash(localPath), remote: fileHash(remotePath) };
      const result = reconcileLedgerSqliteSnapshots({ local_db_path: localPath, remote_db_path: remotePath });

      expect(result.output.mode).toBe("dry_run");
      expect(result.output.wrote_output).toBe(false);
      expect(result.conflicts[0].reason).toBe("done_cancelled_conflict");
      expect(result.suggested_files.local_snapshot).toMatch(/^local\.\d{8}T\d{6}Z\.sqlite$/);
      expect(result.suggested_files.remote_snapshot).toMatch(/^remote\.\d{8}T\d{6}Z\.sqlite$/);
      expect(result.suggested_files.merged_snapshot).toMatch(/^merged\.\d{8}T\d{6}Z\.sqlite$/);
      expect(result.suggested_files.conflicts_report).toMatch(/^conflicts\.\d{8}T\d{6}Z\.json$/);
      expect(fileHash(localPath)).toBe(before.local);
      expect(fileHash(remotePath)).toBe(before.remote);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes merged SQLite output only to an explicit distinct path", () => {
    const root = join(tmpdir(), `opencode-pair-sqlite-output-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(root, { recursive: true });
    const localPath = join(root, "local.sqlite");
    const remotePath = join(root, "remote.sqlite");
    const outputPath = join(root, "merged.sqlite");
    let before: { local: string; remote: string };
    try {
      new OrchestratorLedger(localPath);
      new OrchestratorLedger(remotePath);
      const localDb = new Database(localPath);
      const remoteDb = new Database(remotePath);
      localDb.query("INSERT INTO missions (id, title, goal, status, created_at, updated_at) VALUES ('M-001', 'Local mission', 'Goal', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')").run();
      localDb.query("INSERT INTO tasks (id, mission_id, title, type, assigned_agent, status, priority, created_at, updated_at) VALUES ('T-001', 'M-001', 'Local task', 'implementation', 'implementation-engineer', 'pending', 'high', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')").run();
      remoteDb.query("INSERT INTO missions (id, title, goal, status, created_at, updated_at) VALUES ('M-002', 'Remote mission', 'Goal', 'active', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')").run();
      remoteDb.query("INSERT INTO tasks (id, mission_id, title, type, assigned_agent, status, priority, created_at, updated_at) VALUES ('T-002', 'M-002', 'Remote task', 'implementation', 'implementation-engineer', 'in_progress', 'medium', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')").run();
      localDb.close();
      remoteDb.close();
      before = { local: fileHash(localPath), remote: fileHash(remotePath) };

      expect(() => reconcileLedgerSqliteSnapshots({ local_db_path: localPath, remote_db_path: remotePath, output_db_path: localPath, dry_run: false })).toThrow("Refusing to write merged output over an input snapshot");
      const result = reconcileLedgerSqliteSnapshots({ local_db_path: localPath, remote_db_path: remotePath, output_db_path: outputPath, dry_run: false });
      expect(result.output.mode).toBe("written");
      expect(result.output.db_path).toBe(outputPath);
      expect(fileHash(localPath)).toBe(before.local);
      expect(fileHash(remotePath)).toBe(before.remote);

      const mergedDb = new Database(outputPath, { readonly: true });
      const tasks = mergedDb.query("SELECT id FROM tasks ORDER BY id").all() as Array<{ id: string }>;
      mergedDb.close();
      expect(tasks.map((row) => row.id)).toEqual(["T-001", "T-002"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves append-only rows with dedupe and forks sequential id collisions", () => {
    const result = reconcileLedgerSnapshots(
      { artifacts: [{ id: "A-001", task_id: "T-001", type: "test_log", title: "same", content: "pass" }] },
      { artifacts: [{ id: "A-001", task_id: "T-001", type: "test_log", title: "different", content: "also pass" }] },
    );
    expect(result.conflicts).toEqual([]);
    expect(result.stats.forked_rows).toBe(1);
    expect(result.merged.artifacts).toHaveLength(2);
    expect(result.merged.artifacts.some((row) => String(row.id).startsWith("A-001@remote-"))).toBe(true);

    const deduped = reconcileLedgerSnapshots(
      { decisions: [{ id: "D-001", title: "Keep", content: "same" }] },
      { decisions: [{ id: "D-001", title: "Keep", content: "same" }] },
    );
    expect(deduped.stats.deduped_rows).toBe(1);
    expect(deduped.merged.decisions).toHaveLength(1);
  });

  it("uses safe task and mission status defaults", () => {
    const reopened = reconcileLedgerSnapshots(
      { tasks: [{ id: "T-001", status: "done", updated_at: "2026-01-03T00:00:00.000Z" }] },
      { tasks: [{ id: "T-001", status: "needs_verification", updated_at: "2026-01-02T00:00:00.000Z" }] },
    );
    expect(reopened.conflicts).toEqual([]);
    expect(reopened.merged.tasks[0].status).toBe("needs_verification");

    const terminalConflict = reconcileLedgerSnapshots(
      { tasks: [{ id: "T-002", status: "done" }] },
      { tasks: [{ id: "T-002", status: "cancelled" }] },
    );
    expect(terminalConflict.conflicts[0].reason).toBe("done_cancelled_conflict");
    expect(terminalConflict.merged.tasks).toHaveLength(2);

    const mission = reconcileLedgerSnapshots(
      { missions: [{ id: "M-001", status: "done", updated_at: "2026-01-03T00:00:00.000Z" }] },
      { missions: [{ id: "M-001", status: "cancelled", updated_at: "2026-01-04T00:00:00.000Z" }] },
    );
    expect(mission.merged.missions[0].status).toBe("blocked");
  });

  it("keeps blockers unresolved and verification request-changes on conflicts", () => {
    const result = reconcileLedgerSnapshots(
      {
        blockers: [{ id: "B-001", status: "resolved", required_user_input: 0, resolved_at: "2026-01-02T00:00:00.000Z" }],
        verification_results: [{ id: "V-001", verdict: "approve", gate_status: "pass", created_at: "2026-01-02T00:00:00.000Z" }],
      },
      {
        blockers: [{ id: "B-001", status: "open", required_user_input: 1, resolved_at: null }],
        verification_results: [{ id: "V-001", verdict: "request-changes", gate_status: "fail", created_at: "2026-01-03T00:00:00.000Z" }],
      },
    );
    expect(result.merged.blockers[0].status).toBe("open");
    expect(result.merged.blockers[0].required_user_input).toBe(1);
    expect(result.merged.verification_results[0].verdict).toBe("request-changes");
    expect(result.merged.verification_results[0].gate_status).toBe("fail");
  });

  it("ends remote active sessions in merge plans", () => {
    const result = reconcileLedgerSnapshots(
      {
        sessions: [{ id: "S-001", opencode_session_id: "local", machine_id: "local", status: "active", updated_at: "2026-01-03T00:00:00.000Z" }],
      },
      {
        sessions: [{ id: "S-002", opencode_session_id: "remote", machine_id: "remote", status: "active", updated_at: "2026-01-02T00:00:00.000Z" }],
      },
    );
    expect(result.merged.sessions.find((row) => row.id === "S-002")?.status).toBe("ended");
    expect(result.warnings.join(" ")).toContain("Remote active sessions");
  });

  it("fails fast with a clear error for outdated ledger schemas", () => {
    const root = join(
      tmpdir(),
      `opencode-pair-ledger-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(join(root, "state"), { recursive: true });
    const dbPath = join(root, "state", "orchestrator.sqlite");
    const db = new Database(dbPath);

    try {
      db.exec(`
        PRAGMA user_version = 1;
        CREATE TABLE missions (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          goal TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          metadata_json TEXT NOT NULL DEFAULT '{}'
        );
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          mission_id TEXT REFERENCES missions(id) ON DELETE CASCADE,
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
        CREATE TABLE artifacts (
          id TEXT PRIMARY KEY,
          mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
          task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
          type TEXT NOT NULL,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE context_bundles (
          id TEXT PRIMARY KEY,
          mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
          task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          created_by TEXT NOT NULL,
          tags_json TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL
        );
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          opencode_session_id TEXT NOT NULL UNIQUE,
          cwd TEXT NOT NULL,
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
    } finally {
      db.close();
    }

    try {
      let error: unknown;
      try {
        new OrchestratorLedger(dbPath);
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/Incompatible orchestrator ledger schema/);
      expect((error as Error).message).toMatch(/tasks\.project_id/);
      expect((error as Error).message).toMatch(
        /Reset the ignored local ledger database and restart OpenCode/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists missions, tasks, context, blockers, and gate state", () => {
    withLedger((ledger) => {
      const mission = ledger.createMission({ title: "Mission", goal: "Goal" });
      const task = ledger.createTask({
        mission_id: mission.id,
        title: "Build feature",
        type: "implementation",
        assigned_agent: "implementation-engineer",
        scope: "src",
        acceptance_criteria: ["Typecheck passes"],
      });
      ledger.publishContextBundle({
        task_id: task.id,
        title: "Repo pattern",
        content: "Use existing prompt builders.",
        created_by: "repo-scout",
        tags: ["repo"],
      });
      ledger.publishArtifact({
        task_id: task.id,
        type: "test_log",
        title: "Blocked check",
        content: "Deploy was not run because approval is required.",
        created_by: "implementation-engineer",
      });
      const blocker = ledger.createBlocker({
        task_id: task.id,
        severity: "high",
        title: "Needs approval",
        description: "External deploy requires approval.",
        required_user_input: true,
        created_by: "implementation-engineer",
      });

      expect(blocker.id).toBe("B-001");
      const gate = ledger.checkGate(mission.id);
      expect(gate.gate_status).toBe("blocked");
      expect(gate.can_final_success).toBe(false);
      expect(gate.unresolved_blockers[0]?.title).toBe("Needs approval");
      expect(ledger.queryContextBundles({ task_id: task.id })[0]?.title).toBe("Repo pattern");
      expect(ledger.queryArtifacts({ task_id: task.id, type: "test_log" })[0]?.title).toBe(
        "Blocked check",
      );
      expect(
        ledger.resolveBlocker({
          blocker_id: blocker.id,
          resolution: "User approved skipping deploy.",
          resolved_by: "mission-control",
        }).resolved,
      ).toBe(true);
      expect(ledger.checkGate(mission.id).unresolved_blockers).toEqual([]);
    });
  });

  it("downgrades done task updates without evidence", () => {
    withLedger((ledger) => {
      const mission = ledger.createMission({ title: "Mission", goal: "Goal" });
      const task = ledger.createTask({
        mission_id: mission.id,
        title: "Build feature",
        type: "implementation",
        assigned_agent: "implementation-engineer",
        scope: "src",
        acceptance_criteria: ["Build passes"],
      });

      const result = ledger.updateTask({ task_id: task.id, status: "done" });
      expect(result.adjusted).toBe(true);
      expect(result.task.status).toBe("needs_verification");
      expect(ledger.checkGate(mission.id).can_final_success).toBe(false);
    });
  });

  it("creates globally unique task IDs across multiple missions", () => {
    withLedger((ledger) => {
      const firstMission = ledger.createMission({ title: "First mission", goal: "Goal" });
      const firstTask = ledger.createTask({
        mission_id: firstMission.id,
        title: "First task",
        type: "implementation",
        assigned_agent: "implementation-engineer",
        scope: "src",
      });
      const secondMission = ledger.createMission({ title: "Second mission", goal: "Goal" });
      const secondTask = ledger.createTask({
        mission_id: secondMission.id,
        title: "Second task",
        type: "implementation",
        assigned_agent: "implementation-engineer",
        scope: "src",
      });

      expect(firstTask.id).toBe("T-001");
      expect(secondTask.id).toBe("T-002");
      expect(secondTask.id).not.toBe(firstTask.id);
      expect(ledger.listTasks(firstMission.id).map((task) => task.id)).toEqual(["T-001"]);
      expect(ledger.listTasks(secondMission.id).map((task) => task.id)).toEqual(["T-002"]);
    });
  });

  it("creates globally unique artifact and context IDs across multiple missions", async () => {
    await withLedgerAsync(async (ledger, root) => {
      const tools = createOrchestrationTools(ledger);
      const project = ledger.getOrCreateProject({ root_path: root });
      const firstMission = ledger.createMission({ title: "First mission", goal: "Goal" });
      const firstTask = ledger.createTask({
        mission_id: firstMission.id,
        project_id: project.id,
        title: "First task",
        type: "implementation",
        assigned_agent: "implementation-engineer",
        scope: "src",
      });
      const secondMission = ledger.createMission({ title: "Second mission", goal: "Goal" });
      const secondTask = ledger.createTask({
        mission_id: secondMission.id,
        project_id: project.id,
        title: "Second task",
        type: "implementation",
        assigned_agent: "implementation-engineer",
        scope: "src",
      });

      const firstArtifact = ledger.publishArtifact({
        task_id: firstTask.id,
        type: "test_log",
        title: "First artifact",
        content: "first",
        created_by: "implementation-engineer",
      });
      const secondArtifact = await runTool(tools, "orchestrator_artifact_publish", {
        task_id: secondTask.id,
        type: "test_log",
        title: "Second artifact",
        content: "second",
      });
      const updateArtifact = await runTool(tools, "orchestrator_task_update", {
        task_id: secondTask.id,
        status: "needs_verification",
        artifacts: [{ type: "test_log", title: "Update artifact", content: "from update" }],
      });

      const firstContext = ledger.publishContextBundle({
        task_id: firstTask.id,
        title: "First context",
        content: "first context",
        created_by: "repo-scout",
        tags: ["handoff"],
      });
      const secondContext = await runTool(tools, "orchestrator_context_publish", {
        task_id: secondTask.id,
        title: "Second context",
        content: "second context",
        tags: ["handoff"],
      });
      const compactContext = await runTool(tools, "orchestrator_context_compact", {
        project_id: project.id,
        mission_id: secondMission.id,
        task_id: secondTask.id,
        title: "Compacted context",
        source_query: "second",
        tags: ["compact"],
      });

      expect(firstArtifact.id).toBe("A-001");
      expect(secondArtifact.artifact_id).toBe("A-002");
      expect(updateArtifact.ok).toBe(true);
      expect(ledger.queryArtifacts({ task_id: secondTask.id }).map((artifact) => artifact.id).sort()).toEqual([
        "A-002",
        "A-003",
      ]);
      expect(firstContext.id).toBe("CB-001");
      expect(secondContext.context_bundle_id).toBe("CB-002");
      expect(compactContext.context_bundle_id).toBe("CB-003");
      expect(ledger.queryContextBundles({ task_id: secondTask.id }).map((bundle) => bundle.id).sort()).toEqual([
        "CB-002",
        "CB-003",
      ]);
    });
  });

  it("creates globally unique ledger side-record IDs across multiple missions", () => {
    withLedger((ledger) => {
      const firstMission = ledger.createMission({ title: "First mission", goal: "Goal" });
      const firstTask = ledger.createTask({
        mission_id: firstMission.id,
        title: "First task",
        type: "implementation",
        assigned_agent: "implementation-engineer",
        scope: "src",
      });
      const secondMission = ledger.createMission({ title: "Second mission", goal: "Goal" });
      const secondTask = ledger.createTask({
        mission_id: secondMission.id,
        title: "Second task",
        type: "implementation",
        assigned_agent: "implementation-engineer",
        scope: "src",
      });

      expect(
        ledger.recordDecision({ task_id: firstTask.id, title: "First", content: "first", created_by: "mission-control" }).id,
      ).toBe("D-001");
      expect(
        ledger.recordDecision({ task_id: secondTask.id, title: "Second", content: "second", created_by: "mission-control" }).id,
      ).toBe("D-002");
      expect(
        ledger.createBlocker({
          task_id: firstTask.id,
          severity: "low",
          title: "First blocker",
          description: "first",
          required_user_input: false,
          created_by: "implementation-engineer",
        }).id,
      ).toBe("B-001");
      expect(
        ledger.createBlocker({
          task_id: secondTask.id,
          severity: "low",
          title: "Second blocker",
          description: "second",
          required_user_input: false,
          created_by: "implementation-engineer",
        }).id,
      ).toBe("B-002");
      expect(
        ledger.recordVerification({
          task_id: firstTask.id,
          verdict: "request-changes",
          gate_status: "fail",
          report: {},
          created_by: "verification-engineer",
        }).id,
      ).toBe("V-001");
      expect(
        ledger.recordVerification({
          task_id: secondTask.id,
          verdict: "request-changes",
          gate_status: "fail",
          report: {},
          created_by: "verification-engineer",
        }).id,
      ).toBe("V-002");
    });
  });

  it("creates, resolves, and updates first-class projects by root path", () => {
    withLedger((ledger, root) => {
      const project = ledger.getOrCreateProject({
        root_path: root,
        name: "Pair repo",
        metadata: { packageManager: "bun" },
      });

      expect(project.id).toBe("P-001");
      expect(project.root_path).toBe(root);
      expect(ledger.getOrCreateProject({ root_path: root }).id).toBe(project.id);
      expect(ledger.resolveProject(join(root, "src", "orchestrator", "ledger.ts"))?.id).toBe(project.id);

      const updated = ledger.updateProject({
        project_id: project.id,
        name: "Updated repo",
        metadata: { language: "typescript" },
      });
      expect(updated.name).toBe("Updated repo");
      expect(updated.metadata).toEqual({ packageManager: "bun", language: "typescript" });
    });
  });

  it("stores and merges durable project sensitivity profiles in project metadata", () => {
    withLedger((ledger, root) => {
      const project = ledger.getOrCreateProject({ root_path: root, metadata: { packageManager: "bun" } });
      expect(ledger.getProjectSensitivityProfile(project.id)).toBeUndefined();

      const created = ledger.updateProjectSensitivityProfile({
        project_id: project.id,
        append_entries: [
          { kind: "hard_constraint", text: "Stay inside assigned file scope.", source: "user", precedence: 80 },
          { kind: "tool_policy", text: "Use local tests before reporting done.", source: "repo_detected", precedence: 40 },
          { kind: "risk_flag", text: "Stop before irreversible data changes.", source: "config", precedence: 90, risk: "data_loss" },
          { kind: "repo_note", text: "Bun and TypeScript repo.", source: "repo_detected", precedence: 10 },
        ],
      });

      expect(created.schema_version).toBe(1);
      expect(created.entries.map((entry) => entry.kind)).toEqual([
        "hard_constraint",
        "tool_policy",
        "risk_flag",
        "repo_note",
      ]);
      expect(ledger.getProject(project.id)?.metadata.packageManager).toBe("bun");
      expect(ledger.getProjectSensitivityProfile(project.id)?.entries).toHaveLength(4);

      const firstID = created.entries[0].id;
      const updated = ledger.updateProjectSensitivityProfile({
        project_id: project.id,
        append_entries: [
          { kind: "preference", text: "Prefer smallest reversible diffs.", source: "user", precedence: 70, supersedes: [firstID] },
        ],
      });

      expect(updated.entries.find((entry) => entry.id === firstID)?.active).toBe(false);
      expect(updated.entries.some((entry) => entry.kind === "preference" && entry.source === "user")).toBe(true);
      expect(ledger.getProject(project.id)?.metadata.sensitivity_profile).toEqual(updated);
    });
  });

  it("maps the same txt-marked project across different absolute roots", () => {
    withLedger((ledger, root) => {
      const firstRoot = join(root, "checkout-a");
      const secondRoot = join(root, "checkout-b");
      for (const checkout of [firstRoot, secondRoot]) {
        mkdirSync(join(checkout, ".opencode"), { recursive: true });
        writeFileSync(
          join(checkout, ".opencode", "orch.txt"),
          "version=1\nproject_key=project:shared-repo\nname=Shared repo\nrepo_fingerprint=repo:test\n",
        );
      }

      const first = ledger.getOrCreateProject({ root_path: firstRoot, name: "Shared repo" });
      const second = ledger.getOrCreateProject({ root_path: secondRoot, name: "Shared repo on laptop" });

      expect(second.id).toBe(first.id);
      expect(second.project_key).toBe("project:shared-repo");
      expect(second.root_path).toBe(secondRoot);
      expect(ledger.resolveProject(join(firstRoot, "src", "index.ts"))?.id).toBe(first.id);
      expect(ledger.resolveProject(join(secondRoot, "src", "index.ts"))?.id).toBe(first.id);
    });
  });

  it("derives git project identity when no marker exists", () => {
    withLedger((ledger, root) => {
      const firstRoot = join(root, "git-a");
      const secondRoot = join(root, "git-b");
      for (const checkout of [firstRoot, secondRoot]) {
        mkdirSync(join(checkout, ".git", "refs", "heads"), { recursive: true });
        writeFileSync(join(checkout, ".git", "config"), '[remote "origin"]\n  url = git@github.com:example/shared.git\n');
        writeFileSync(join(checkout, ".git", "HEAD"), "ref: refs/heads/main\n");
        writeFileSync(join(checkout, ".git", "refs", "heads", "main"), "0123456789abcdef0123456789abcdef01234567\n");
      }

      const first = ledger.getOrCreateProject({ root_path: firstRoot });
      const second = ledger.getOrCreateProject({ root_path: secondRoot });

      expect(second.id).toBe(first.id);
      expect(first.project_key).toBe("git:https://github.com/example/shared#0123456789ab");
    });
  });

  it("keeps synced sessions machine-local", () => {
    withLedger((ledger, root) => {
      const project = ledger.getOrCreateProject({ root_path: root, metadata: { project_key: "project:local-runtime" } });
      const mission = ledger.createMission({ title: "Mission", goal: "Goal" });
      const first = ledger.createTask({ mission_id: mission.id, project_id: project.id, title: "First", type: "implementation", assigned_agent: "implementation-engineer", scope: "src" });
      ledger.createTask({ mission_id: mission.id, project_id: project.id, title: "Second", type: "frontend", assigned_agent: "frontend-engineer", scope: "src/app" });

      const db = new Database(ledger.dbPath);
      db.query(
        `INSERT INTO sessions (id, opencode_session_id, project_id, cwd, machine_id, status, started_at, updated_at, metadata_json)
         VALUES ('S-remote', 'remote-session', $projectID, $cwd, 'host:remote', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '{}')`,
      ).run({ $projectID: project.id, $cwd: root });
      db.close();

      expect(ledger.listProjectSessions({ project_id: project.id })).toEqual([]);
      expect(ledger.getSession("remote-session")).toBeUndefined();

      const localSession = ledger.attachSession({ opencode_session_id: "local-session", project_id: project.id, cwd: root });
      expect(localSession.machine_id).toBe(getMachineId());
      expect(ledger.listProjectSessions({ project_id: project.id })[0]?.opencode_session_id).toBe("local-session");
    });
  });

  it("attaches and updates durable OpenCode sessions", () => {
    withLedger((ledger, root) => {
      const project = ledger.getOrCreateProject({ root_path: root });
      const mission = ledger.createMission({ title: "Mission", goal: "Goal" });
      const task = ledger.createTask({
        mission_id: mission.id,
        project_id: project.id,
        title: "Session task",
        type: "implementation",
        assigned_agent: "implementation-engineer",
        scope: "src",
      });

      const session = ledger.attachSession({
        opencode_session_id: "oc-session-1",
        project_id: project.id,
        cwd: join(root, "src"),
        active_mission_id: mission.id,
        active_task_id: task.id,
        agent: "implementation-engineer",
        metadata: { source: "test" },
      });
      expect(session.id).toBe("S-001");
      expect(session.project_id).toBe(project.id);
      expect(session.active_task_id).toBe(task.id);
      expect(ledger.getSessionTask("oc-session-1")?.id).toBe(task.id);

      const ended = ledger.updateSession({
        opencode_session_id: "oc-session-1",
        status: "ended",
        active_task_id: null,
        metadata: { result: "pass" },
      });
      expect(ended.status).toBe("ended");
      expect(ended.ended_at).toBeTruthy();
      expect(ended.active_task_id).toBeUndefined();
      expect(ended.metadata).toEqual({ source: "test", result: "pass" });
    });
  });

  it("renders compact task-first worker packets without duplicated base boilerplate", () => {
    withLedger((ledger, root) => {
      const project = ledger.getOrCreateProject({ root_path: root, name: "Compact repo" });
      ledger.updateProjectSensitivityProfile({
        project_id: project.id,
        append_entries: [
          { kind: "preference", text: "Prefer smallest reversible diffs.", source: "repo_detected", precedence: 80 },
          { kind: "risk_flag", text: "Do not print credential values in reports.", source: "user", precedence: 100 },
        ],
      });
      const mission = ledger.createMission({ title: "Packet mission", goal: "Short worker packets" });
      const dependency = ledger.createTask({
        mission_id: mission.id,
        project_id: project.id,
        title: "Discovery",
        type: "repo_scout",
        assigned_agent: "repo-scout",
        scope: "Map renderer",
        status: "done",
      });
      const task = ledger.createTask({
        mission_id: mission.id,
        project_id: project.id,
        title: "Refactor packet renderer",
        type: "implementation",
        assigned_agent: "implementation-engineer",
        scope: "Change worker packet rendering only",
        file_scope: ["src/orchestrator/ledger.ts", "src/__tests__/**"],
        dependencies: [dependency.id],
        acceptance_criteria: ["Packet has final task block", "No duplicated contract boilerplate"],
        evidence_requirements: ["Prompt render test"],
      });
      ledger.publishContextBundle({
        mission_id: mission.id,
        project_id: project.id,
        task_id: task.id,
        title: "Renderer note",
        content: "Base worker prompts own output contracts.",
        created_by: "repo-scout",
      });
      ledger.linkSessionToTask("compact-worker", task.id, "implementation-engineer");

      const packet = ledger.buildWorkerPacket("compact-worker", "implementation-engineer");

      expect(packet).toContain("<InheritedContext>");
      expect(packet).toContain("Project profile: preference/repo_detected: Prefer smallest reversible diffs.");
      expect(packet).toContain("Dependencies: T-001:done");
      expect(packet).toContain("Context bundles: CB-001:Renderer note=Base worker prompts own output contracts.");
      expect(packet).toContain("<TaskFacts>");
      expect(packet).not.toContain("<ExtraDelta>");
      expect(packet).toContain(`Task: ${task.id} pending priority=medium`);
      expect(packet).toContain("Acceptance: [ ] Packet has final task block; [ ] No duplicated contract boilerplate");
      expect(packet).toContain("<Task>\nComplete T-002: Refactor packet renderer");
      expect(packet).toContain("return the base worker JSON report");
      expect(packet).not.toContain("WorkerReportContract");
      expect(packet).not.toContain("OutputContract");
      expect(packet).not.toContain('"task_id": "T-001"');
      expect(packet).not.toMatch(/secret|credential|security|token|env-secret|commit-secret/i);
    });
  });

  it("renders only task-specific extra deltas and marks user-added constraints", () => {
    withLedger((ledger, root) => {
      const project = ledger.getOrCreateProject({ root_path: root, name: "Delta repo" });
      const mission = ledger.createMission({ title: "Delta mission", goal: "Short worker packets" });
      const task = ledger.createTask({
        mission_id: mission.id,
        project_id: project.id,
        title: "Tune compact packet renderer",
        type: "implementation",
        assigned_agent: "implementation-engineer",
        scope: "src/orchestrator/ledger.ts packet renderer",
        file_scope: ["src/orchestrator/ledger.ts"],
        acceptance_criteria: ["Extra section only includes deltas"],
        evidence_requirements: ["Prompt render test"],
      });
      ledger.updateProjectSensitivityProfile({
        project_id: project.id,
        append_entries: [
          { kind: "preference", text: "Prefer existing compact packet section names.", source: "repo_detected", precedence: 90, scope: "src/orchestrator/ledger.ts" },
          { kind: "hard_constraint", text: "Keep packet renderer changes inside ledger.ts.", source: "user", precedence: 120, scope: task.id },
          { kind: "preference", text: "Use concise snapshot assertions for this renderer task.", source: "mission", precedence: 80, scope: "Tune compact packet renderer" },
          { kind: "risk_flag", text: "Do not print credential values in renderer packets.", source: "user", precedence: 130, scope: task.id },
          { kind: "preference", text: "Project-wide style stays terse.", source: "user", precedence: 70 },
        ],
      });
      ledger.linkSessionToTask("delta-worker", task.id, "implementation-engineer");

      const packet = ledger.buildWorkerPacket("delta-worker", "implementation-engineer");

      expect(packet).toContain("<InheritedContext>");
      expect(packet).toContain("Project profile: preference/repo_detected: Prefer existing compact packet section names.");
      expect(packet).toContain("<ExtraDelta>");
      expect(packet).toContain("Only task-specific deltas from base worker rules/project profile:");
      expect(packet).toMatch(/- hard_constraint \(user-added source=user date=\d{4}-\d{2}-\d{2} precedence=120\): Keep packet renderer changes inside ledger\.ts\./);
      expect(packet).toMatch(/- risk_flag \(user-added source=user date=\d{4}-\d{2}-\d{2} precedence=130\): Do not print credential values in renderer packets\./);
      expect(packet).toMatch(/- preference \(source=mission date=\d{4}-\d{2}-\d{2} precedence=80\): Use concise snapshot assertions for this renderer task\./);
      expect(packet).not.toContain("Project-wide style stays terse");
      expect(packet).not.toContain("WorkerReportContract");
      expect(packet).not.toContain("OutputContract");
      expect(packet.indexOf("</TaskFacts>")).toBeLessThan(packet.indexOf("<ExtraDelta>"));
      expect(packet.indexOf("</ExtraDelta>")).toBeLessThan(packet.indexOf("<Task>"));
    });
  });

  it("renders current packet profile and task wording for ordinary, env, and commit-related fixtures", () => {
    withLedger((ledger, root) => {
      const project = ledger.getOrCreateProject({ root_path: root, name: "D-089 repo" });
      const mission = ledger.createMission({ title: "D-089 packet mission", goal: "Keep packet text clean" });
      ledger.updateProjectSensitivityProfile({
        project_id: project.id,
        append_entries: [
          { kind: "preference", text: "Prefer compact packet wording.", source: "repo_detected", precedence: 80 },
          { kind: "risk_flag", text: "Do not print credential values in packets.", source: "repo_detected", precedence: 90 },
          { kind: "risk_flag", text: "Do not include security boilerplate in packets.", source: "repo_detected", precedence: 85 },
          { kind: "hard_constraint", text: "Never expose token strings in task deltas.", source: "user", precedence: 100, scope: "env setup" },
        ],
      });

      const fixtures = [
        ledger.createTask({
          mission_id: mission.id,
          project_id: project.id,
          title: "Ordinary renderer cleanup",
          type: "implementation",
          assigned_agent: "implementation-engineer",
          scope: "Refine packet renderer",
          acceptance_criteria: ["Packet is compact"],
        }),
        ledger.createTask({
          mission_id: mission.id,
          project_id: project.id,
          title: "Prepare credential env setup",
          type: "implementation",
          assigned_agent: "implementation-engineer",
          scope: "Use provided credentials in ignored env setup only when needed",
          acceptance_criteria: ["Credential values are available to local env setup"],
          evidence_requirements: ["Env setup test uses provided token"],
        }),
        ledger.createTask({
          mission_id: mission.id,
          project_id: project.id,
          title: "Commit selection with secret exposure note",
          type: "implementation",
          assigned_agent: "implementation-engineer",
          scope: "Review commit-related credential wording in packet content",
          acceptance_criteria: ["Commit packet omits secret-safety boilerplate", "Security wording stays filtered"],
          evidence_requirements: ["Prompt render check covers commit-secret wording", "Security render check"],
        }),
      ];

      for (const task of fixtures) {
        ledger.linkSessionToTask(`d089-${task.id}`, task.id, "implementation-engineer");
        const packet = ledger.buildWorkerPacket(`d089-${task.id}`, "implementation-engineer");

        expect(packet).toContain("preference/repo_detected: Prefer compact packet wording.");
        expect(packet).toContain("risk_flag/repo_detected: Do not print credential values in packets.");
        expect(packet).toContain("risk_flag/repo_detected: Do not include security boilerplate in packets.");
        if (task.title === "Prepare credential env setup") {
          expect(packet).toContain("Never expose token strings in task deltas.");
        } else {
          expect(packet).not.toContain("Never expose token strings in task deltas.");
        }
      }
    });
  });

  it("tracks project backlog tasks and parent/subtask relationships without changing mission listings", () => {
    withLedger((ledger, root) => {
      const project = ledger.getOrCreateProject({ root_path: root });
      const mission = ledger.createMission({ title: "Mission", goal: "Goal" });
      const missionTask = ledger.createTask({
        mission_id: mission.id,
        project_id: project.id,
        title: "Mission task",
        type: "implementation",
        assigned_agent: "implementation-engineer",
        scope: "src",
      });
      const backlog = ledger.createTask({
        project_id: project.id,
        title: "Backlog task",
        type: "docs",
        assigned_agent: "implementation-engineer",
        backlog_status: "backlog",
        scope: "docs",
      });
      const subtask = ledger.createTask({
        project_id: project.id,
        parent_task_id: backlog.id,
        title: "Backlog subtask",
        type: "docs",
        assigned_agent: "implementation-engineer",
        backlog_status: "ready",
        scope: "docs/notes.md",
      });

      expect(backlog.mission_id).toBeUndefined();
      expect(subtask.parent_task_id).toBe(backlog.id);
      expect(ledger.listTasks(mission.id).map((task) => task.id)).toEqual([missionTask.id]);
      expect(ledger.listProjectTasks({ project_id: project.id }).map((task) => task.id)).toEqual([
        missionTask.id,
        backlog.id,
        subtask.id,
      ]);
      expect(
        ledger.listProjectTasks({ project_id: project.id, backlog_status: "backlog" }).map((task) => task.id),
      ).toEqual([backlog.id]);
      expect(
        ledger.listProjectTasks({ project_id: project.id, parent_task_id: backlog.id }).map((task) => task.id),
      ).toEqual([subtask.id]);
    });
  });

  it("normalizes no-parent task create tool inputs and preserves valid parent ids", async () => {
    await withLedgerAsync(async (ledger, root) => {
      const tools = createOrchestrationTools(ledger);
      const project = ledger.getOrCreateProject({ root_path: root });
      const mission = ledger.createMission({ title: "Mission", goal: "Goal" });

      const omitted = await runTool(tools, "orchestrator_task_create", {
        mission_id: mission.id,
        project_id: project.id,
        title: "Top-level omitted parent",
        type: "implementation",
        assigned_agent: "implementation-engineer",
        scope: "src",
      });
      expect(omitted.ok).toBe(true);
      expect(ledger.getTask(omitted.task.id)?.parent_task_id).toBeUndefined();

      const empty = await runTool(tools, "orchestrator_task_create", {
        mission_id: mission.id,
        project_id: project.id,
        parent_task_id: "  ",
        title: "Top-level empty parent",
        type: "implementation",
        assigned_agent: "implementation-engineer",
        scope: "src",
      });
      expect(empty.ok).toBe(true);
      expect(ledger.getTask(empty.task.id)?.parent_task_id).toBeUndefined();

      const nullable = await runTool(tools, "orchestrator_task_create", {
        mission_id: mission.id,
        project_id: project.id,
        parent_task_id: null,
        title: "Top-level null parent",
        type: "implementation",
        assigned_agent: "implementation-engineer",
        scope: "src",
      });
      expect(nullable.ok).toBe(true);
      expect(ledger.getTask(nullable.task.id)?.parent_task_id).toBeUndefined();

      for (const parent_task_id of ["none", "null", "undefined"]) {
        const noValue = await runTool(tools, "orchestrator_task_create", {
          mission_id: mission.id,
          project_id: project.id,
          parent_task_id,
          title: `Top-level ${parent_task_id} parent`,
          type: "implementation",
          assigned_agent: "implementation-engineer",
          scope: "src",
        });
        expect(noValue.ok).toBe(true);
        expect(ledger.getTask(noValue.task.id)?.parent_task_id).toBeUndefined();
      }

      const child = await runTool(tools, "orchestrator_task_create", {
        mission_id: mission.id,
        project_id: project.id,
        parent_task_id: omitted.task.id,
        title: "Child task",
        type: "implementation",
        assigned_agent: "implementation-engineer",
        scope: "src/orchestrator",
      });
      expect(child.ok).toBe(true);
      expect(ledger.getTask(child.task.id)?.parent_task_id).toBe(omitted.task.id);

      const invalidParent = await runTool(tools, "orchestrator_task_create", {
        mission_id: mission.id,
        project_id: project.id,
        parent_task_id: "T-999",
        title: "Invalid child task",
        type: "implementation",
        assigned_agent: "implementation-engineer",
        scope: "src/orchestrator",
      });
      expect(invalidParent.ok).toBe(false);
      expect(invalidParent.message).toContain("Invalid parent_task_id: T-999");
      expect(invalidParent.message).toContain("No matching task exists");
    });
  });

  it("returns actionable tool errors for invalid optional id references", async () => {
    await withLedgerAsync(async (ledger, root) => {
      const tools = createOrchestrationTools(ledger);
      const project = ledger.getOrCreateProject({ root_path: root });
      const mission = ledger.createMission({ title: "Mission", goal: "Goal" });
      const task = ledger.createTask({
        mission_id: mission.id,
        project_id: project.id,
        title: "Task",
        type: "implementation",
        assigned_agent: "implementation-engineer",
        scope: "src",
      });

      const invalidProject = await runTool(tools, "orchestrator_project_tasks", {
        project_id: "P-999",
      });
      expect(invalidProject.ok).toBe(false);
      expect(invalidProject.message).toContain("Invalid project_id: P-999");
      expect(invalidProject.recovery).toContain("existing ledger id");

      const invalidTask = await runTool(tools, "orchestrator_artifact_publish", {
        task_id: "T-999",
        type: "test_log",
        title: "Invalid artifact",
        content: "bad task",
      });
      expect(invalidTask.ok).toBe(false);
      expect(invalidTask.message).toContain("Invalid task_id: T-999");

      const invalidMission = await runTool(tools, "orchestrator_context_publish", {
        mission_id: "M-missing",
        task_id: "none",
        title: "Invalid context",
        content: "bad mission",
      });
      expect(invalidMission.ok).toBe(false);
      expect(invalidMission.message).toContain("Invalid mission_id: M-missing");

      const noTaskToken = await runTool(tools, "orchestrator_artifact_publish", {
        task_id: "none",
        type: "test_log",
        title: "Sessionless artifact",
        content: "falls back to active mission",
      });
      expect(noTaskToken.ok).toBe(true);
      expect(ledger.queryArtifacts({ task_id: task.id }).some((artifact) => artifact.id === noTaskToken.artifact_id)).toBe(false);
    });
  });

  it("runs project, session, current-task, and context tool flows", async () => {
    await withLedgerAsync(async (ledger, root) => {
      const tools = createOrchestrationTools(ledger);
      const projectResult = await runTool(tools, "orchestrator_project_resolve", {
        root_path: root,
        name: "Tool repo",
        create: true,
      });
      expect(projectResult.ok).toBe(true);
      expect(projectResult.project.id).toBe("P-001");

      const projectByName = await runTool(tools, "orchestrator_project_resolve", {
        name: "Tool repo",
      });
      expect(projectByName.ok).toBe(true);
      expect(projectByName.project.id).toBe(projectResult.project.id);

      const profileWrite = await runTool(tools, "orchestrator_project_sensitivity_profile", {
        project_id: projectResult.project.id,
        append_entries: [
          { kind: "hard_constraint", text: "Preserve existing architecture.", source: "user", precedence: 80 },
          { kind: "risk_flag", text: "Stop before external writes.", source: "config", risk: "external_write", precedence: 70 },
        ],
      });
      expect(profileWrite.ok).toBe(true);
      expect(profileWrite.profile.entries).toHaveLength(2);

      const profileRead = await runTool(tools, "orchestrator_project_sensitivity_profile", {
        root_path: root,
      });
      expect(profileRead.profile.schema_version).toBe(1);
      expect(profileRead.profile.entries.map((entry: { text: string }) => entry.text)).toContain("Preserve existing architecture.");

      const mission = ledger.createMission({ title: "Mission", goal: "Goal" });
      const parent = ledger.createTask({
        mission_id: mission.id,
        project_id: projectResult.project.id,
        title: "Parent task",
        type: "implementation",
        assigned_agent: "implementation-engineer",
        scope: "src",
      });
      const child = ledger.createTask({
        mission_id: mission.id,
        project_id: projectResult.project.id,
        parent_task_id: parent.id,
        title: "Child task",
        type: "implementation",
        assigned_agent: "implementation-engineer",
        scope: "src/orchestrator",
        dependencies: [parent.id],
      });
      ledger.publishContextBundle({
        mission_id: mission.id,
        project_id: projectResult.project.id,
        task_id: child.id,
        title: "Context note",
        content: "Use direct ledger context search for workers.",
        created_by: "repo-scout",
        tags: ["repo", "context"],
      });
      ledger.publishArtifact({
        mission_id: mission.id,
        project_id: projectResult.project.id,
        task_id: child.id,
        type: "test_log",
        title: "Tool evidence",
        content: "handler flow passed",
        created_by: "implementation-engineer",
      });

      const attach = await runTool(tools, "orchestrator_session_attach", {
        project_id: projectResult.project.id,
        active_mission_id: mission.id,
        active_task_id: child.id,
        cwd: join(root, "src"),
      });
      expect(attach.session.active_task_id).toBe(child.id);

      const current = await runTool(tools, "orchestrator_session_current", {});
      expect(current.project.id).toBe(projectResult.project.id);
      expect(current.task.id).toBe(child.id);
      expect(current.context.some((item: { title: string }) => item.title === "Context note")).toBe(true);

      const currentTask = await runTool(tools, "orchestrator_get_current_task", {});
      expect(currentTask.task.id).toBe(child.id);
      expect(currentTask.dependencies[0].id).toBe(parent.id);

      const tasks = await runTool(tools, "orchestrator_project_tasks", {
        project_id: projectResult.project.id,
        parent_task_id: parent.id,
      });
      expect(tasks.tasks.map((task: { id: string }) => task.id)).toEqual([child.id]);

      const search = await runTool(tools, "orchestrator_context_search", {
        project_id: projectResult.project.id,
        query: "ledger context",
      });
      expect(search.results[0].source).toBe("context_bundle");

      const researchRoute = await runTool(tools, "orchestrator_research_route", {
        intent: "official_docs",
        query: "Next.js cache API docs",
      });
      expect(researchRoute.route.route).toEqual(["context7_resolve-library-id", "context7_query-docs"]);
      expect(researchRoute.route.max_call_budget).toBe(3);
      expect(researchRoute.route.evidence_expectations).toContain("official doc snippet or URL");

      const compact = await runTool(tools, "orchestrator_context_compact", {
        project_id: projectResult.project.id,
        mission_id: mission.id,
        task_id: child.id,
        title: "Compact handoff",
        source_query: "handler",
        tags: ["compact"],
      });
      expect(compact.ok).toBe(true);
      expect(compact.source_count).toBeGreaterThan(0);

      const status = await runTool(tools, "orchestrator_project_status", {
        project_id: projectResult.project.id,
      });
      expect(status.sessions[0].active_task_id).toBe(child.id);
      expect(status.tasks.map((task: { id: string }) => task.id)).toContain(child.id);
    });
  });

  it("builds a read-only mission flight deck with lanes and acceptance coverage", async () => {
    await withLedgerAsync(async (ledger, root) => {
      const tools = createOrchestrationTools(ledger);
      const project = ledger.getOrCreateProject({ root_path: root, name: "Flight Deck" });
      const mission = ledger.createMission({ title: "Ship report", goal: "Show mission cockpit" });
      const ready = ledger.createTask({
        mission_id: mission.id,
        project_id: project.id,
        title: "Ready task",
        type: "implementation",
        assigned_agent: "implementation-engineer",
        priority: "high",
        scope: "src",
        acceptance_criteria: [{ criterion: "Plan approved", met: true }],
      });
      const blocked = ledger.createTask({
        mission_id: mission.id,
        project_id: project.id,
        title: "Blocked task",
        type: "implementation",
        assigned_agent: "implementation-engineer",
        status: "blocked",
        scope: "src",
        acceptance_criteria: [{ criterion: "User input", evidence: "Missing secret" }],
      });
      const needsVerification = ledger.createTask({
        mission_id: mission.id,
        project_id: project.id,
        title: "Needs verification",
        type: "verification",
        assigned_agent: "verification-engineer",
        status: "needs_verification",
        scope: "src",
        acceptance_criteria: [{ criterion: "Tested", met: false }],
      });
      const done = ledger.createTask({
        mission_id: mission.id,
        project_id: project.id,
        title: "Done task",
        type: "implementation",
        assigned_agent: "implementation-engineer",
        scope: "src",
        acceptance_criteria: [{ criterion: "Build passes", met: true, evidence: "bun run build", verification_type: "build" }],
      });
      ledger.updateTask({
        task_id: done.id,
        status: "done",
        verification: { mode: "local", commands_or_actions: ["bun run build"], result: "pass" },
      });

      const before = ledger.getTask(ready.id)!.updated_at;
      const report = await runTool(tools, "orchestrator_flight_deck_report", {
        mission_id: mission.id,
      });

      expect(report.ok).toBe(true);
      expect(report.scope).toBe("mission");
      expect(report.lanes.ready.map((task: { id: string }) => task.id)).toContain(ready.id);
      expect(report.lanes.blocked.map((task: { id: string }) => task.id)).toContain(blocked.id);
      expect(report.lanes.needs_verification.map((task: { id: string }) => task.id)).toContain(needsVerification.id);
      expect(report.lanes.done.map((task: { id: string }) => task.id)).toContain(done.id);
      expect(report.acceptance_coverage).toMatchObject({ unmet: 1, claimed: 1, evidenced: 1, verified: 1, total: 4 });
      expect(report.next_safest_action).toBeTruthy();
      expect(ledger.getTask(ready.id)!.updated_at).toBe(before);

      const projectReport = await runTool(tools, "orchestrator_flight_deck_report", {
        project_id: project.id,
      });
      expect(projectReport.scope).toBe("project");
      expect(projectReport.project.id).toBe(project.id);
    });
  });

  it("routes common research intents without external calls", async () => {
    await withLedgerAsync(async (ledger) => {
      const tools = createOrchestrationTools(ledger);

      const officialDocs = await runTool(tools, "orchestrator_research_route", {
        query: "React useEffect cleanup API docs",
      });
      expect(officialDocs.route.intent).toBe("official_docs");
      expect(officialDocs.route.route).toContain("context7_query-docs");
      expect(officialDocs.route.fallback_order).toContain("searxng_web_search official docs");

      const codeExamples = await runTool(tools, "orchestrator_research_route", {
        intent: "real_world_code",
        query: "How apps call getServerSession",
      });
      expect(codeExamples.route.route).toEqual(["grep_app_searchGitHub"]);
      expect(String(codeExamples.route.query_rewrite_hints.join(" "))).toContain("literal code");

      const currentWeb = await runTool(tools, "orchestrator_research_route", {
        query: "latest Node.js LTS release today",
      });
      expect(currentWeb.route.intent).toBe("current_web");
      expect(currentWeb.route.route).toEqual(["searxng_web_search", "searxng_web_url_read"]);
      expect(currentWeb.route.max_call_budget).toBe(4);

      const knownUrl = await runTool(tools, "orchestrator_research_route", {
        url: "https://example.com/docs",
      });
      expect(knownUrl.route.intent).toBe("known_url");
      expect(knownUrl.route.route).toEqual(["searxng_web_url_read"]);

      const repoLocal = await runTool(tools, "orchestrator_research_route", {
        repo_local: true,
        query: "where is auth configured in this repo",
      });
      expect(repoLocal.route.intent).toBe("repo_local");
      expect(repoLocal.route.no_external_call).toBe(true);
      expect(repoLocal.route.max_call_budget).toBe(0);
      expect(repoLocal.route.route).toContain("no_external_call");
    });
  });

  it("preflights MCP tool intents without external calls", async () => {
    await withLedgerAsync(async (ledger) => {
      const tools = createOrchestrationTools(ledger);

      const browser = await runTool(tools, "orchestrator_tool_preflight", {
        intent: "browser_interaction",
      });
      expect(browser.ok).toBe(true);
      expect(browser.preflight.family).toBe("browser");
      expect(browser.preflight.recommended_tools).toEqual(["web-agent-mcp"]);
      expect(browser.preflight.cheapest_first_action).toContain("session_status");
      expect(browser.preflight.side_effect_free).toBe(true);

      const db = await runTool(tools, "orchestrator_tool_preflight", {
        intent: "database_read",
      });
      expect(db.preflight.family).toBe("database");
      expect(db.preflight.risk).toBe("high");
      expect(db.preflight.avoid_or_stop_rules.join(" ")).toContain("stop before writes");

      const ssh = await runTool(tools, "orchestrator_tool_preflight", {
        intent: "remote_ssh",
      });
      expect(ssh.preflight.recommended_tools).toEqual(["ssh-mcp"]);
      expect(ssh.preflight.cheapest_first_action).toContain("list_hosts");

      const image = await runTool(tools, "orchestrator_tool_preflight", {
        intent: "image_generation_or_edit",
      });
      expect(image.preflight.family).toBe("image");
      expect(image.preflight.expected_evidence).toContain("source_prompt_preview");

      const ledgerContext = await runTool(tools, "orchestrator_tool_preflight", {
        intent: "ledger_context",
      });
      expect(ledgerContext.preflight.family).toBe("ledger_context");
      expect(ledgerContext.preflight.risk).toBe("low");

      const research = await runTool(tools, "orchestrator_tool_preflight", {
        intent: "research",
      });
      expect(research.preflight.recommended_tools[0]).toBe("orchestrator_research_route");
      expect(research.preflight.avoid_or_stop_rules.join(" ")).toContain("does not replace orchestrator_research_route");

      const localRepo = await runTool(tools, "orchestrator_tool_preflight", {
        intent: "local_repo",
      });
      expect(localRepo.preflight.family).toBe("local_repo");
      expect(localRepo.preflight.cost).toBe("low");
    });
  });

  it("passes the gate only after evidence-backed completion", () => {
    withLedger((ledger) => {
      const mission = ledger.createMission({ title: "Mission", goal: "Goal" });
      const task = ledger.createTask({
        mission_id: mission.id,
        title: "Build feature",
        type: "implementation",
        assigned_agent: "implementation-engineer",
        scope: "src",
        acceptance_criteria: ["Build passes"],
      });

      const result = ledger.updateTask({
        task_id: task.id,
        status: "done",
        acceptance_criteria: [
          {
            criterion: "Build passes",
            met: true,
            evidence: "bun run build exited 0",
            verification_type: "build",
          },
        ],
        verification: {
          mode: "local",
          commands_or_actions: ["bun run build"],
          result: "pass",
        },
      });

      expect(result.adjusted).toBe(false);
      const gate = ledger.checkGate(mission.id);
      expect(gate.gate_status).toBe("pass");
      expect(gate.can_final_success).toBe(true);
    });
  });

  it("supersedes older request-changes verification with later approval", () => {
    withLedger((ledger) => {
      const mission = ledger.createMission({ title: "Mission", goal: "Goal" });
      const task = ledger.createTask({
        mission_id: mission.id,
        title: "Build feature",
        type: "implementation",
        assigned_agent: "implementation-engineer",
        scope: "src",
        acceptance_criteria: ["Build passes"],
      });
      ledger.updateTask({
        task_id: task.id,
        status: "done",
        acceptance_criteria: [
          {
            criterion: "Build passes",
            met: true,
            evidence: "bun run build exited 0",
            verification_type: "build",
          },
        ],
        verification: {
          mode: "local",
          commands_or_actions: ["bun run build"],
          result: "pass",
        },
      });
      ledger.recordVerification({
        task_id: task.id,
        verdict: "request-changes",
        gate_status: "fail",
        report: { issues: [{ severity: "critical", issue: "outdated" }] },
        created_by: "verification-engineer",
      });
      ledger.recordVerification({
        task_id: task.id,
        verdict: "approve",
        gate_status: "pass",
        report: { issues: [] },
        created_by: "verification-engineer",
      });

      expect(ledger.checkGate(mission.id).gate_status).toBe("pass");
    });
  });

  it("checks latest verifier status across more than twenty tasks", () => {
    withLedger((ledger) => {
      const mission = ledger.createMission({ title: "Mission", goal: "Goal" });
      for (let index = 0; index < 21; index += 1) {
        const task = ledger.createTask({
          mission_id: mission.id,
          title: `Task ${index}`,
          type: "implementation",
          assigned_agent: "implementation-engineer",
          scope: "src",
          acceptance_criteria: [`Criterion ${index}`],
        });
        ledger.updateTask({
          task_id: task.id,
          status: "done",
          acceptance_criteria: [
            {
              criterion: `Criterion ${index}`,
              met: true,
              evidence: "checked",
              verification_type: "manual_reasoning",
            },
          ],
          verification: {
            mode: "local",
            commands_or_actions: ["checked"],
            result: "pass",
          },
        });
        ledger.recordVerification({
          task_id: task.id,
          verdict: index === 0 ? "request-changes" : "approve",
          gate_status: index === 0 ? "fail" : "pass",
          report: index === 0 ? { issues: [{ severity: "critical", issue: "old task failed" }] } : {},
          created_by: "verification-engineer",
        });
      }

      const gate = ledger.checkGate(mission.id);
      expect(gate.gate_status).toBe("fail");
      expect(gate.verification_issues.some((issue) => issue.task_id === "T-001")).toBe(true);
    });
  });

  it("resolves subdirectory cwd-relative writes", () => {
    withLedger((ledger, root) => {
      const frontendRoot = join(root, "blanco-frontend");
      mkdirSync(frontendRoot, { recursive: true });
      const project = ledger.getOrCreateProject({ root_path: root });
      const mission = ledger.createMission({ title: "Mission", goal: "Goal" });
      ledger.createTask({
        mission_id: mission.id,
        project_id: project.id,
        title: "Frontend",
        type: "implementation",
        assigned_agent: "implementation-engineer",
        scope: "blanco-frontend/**",
      });

      expect(ledger.relativePath(frontendRoot, "app/page.tsx")).toBe("blanco-frontend/app/page.tsx");
    });
  });

  it("preflights writer actions without mutating locks or files", async () => {
    await withLedgerAsync(async (ledger, root) => {
      const project = ledger.getOrCreateProject({ root_path: root });
      const mission = ledger.createMission({ title: "Mission", goal: "Goal" });
      const task = ledger.createTask({ mission_id: mission.id, project_id: project.id, title: "Write", type: "implementation", assigned_agent: "implementation-engineer", scope: "src/**", file_scope: ["src/**"] });
      ledger.attachSession({ opencode_session_id: "oc-test-session", project_id: project.id, cwd: root, active_mission_id: mission.id, active_task_id: task.id, agent: "implementation-engineer" });
      const tools = createOrchestrationTools(ledger, {}, root);

      const manifest = await runTool(tools, "orchestrator_guard_manifest", { task_id: task.id });
      expect(manifest.manifest.project_root).toBe(root);
      expect(manifest.manifest.intended_flow).toContain("inspect → act → verify → report");

      const allowedWithoutLock = await runTool(tools, "orchestrator_guard_preflight", { action: "write", paths: ["src/index.ts"], task_id: task.id });
      expect(allowedWithoutLock.preflight.allowed).toBe(true);
      expect(allowedWithoutLock.preflight.reason_code).toBe("write_allowed");
      expect(allowedWithoutLock.preflight.normalized_paths).toEqual(["src/index.ts"]);
      const allowed = await runTool(tools, "orchestrator_guard_preflight", { action: "write", paths: ["src/index.ts"], task_id: task.id });
      expect(allowed.preflight.allowed).toBe(true);
      expect(allowed.preflight.reason_code).toBe("write_allowed");
    });
  });

  it("preflights git, secret env, and pathless edit cases", () => {
    withLedger((ledger, root) => {
      const project = ledger.getOrCreateProject({ root_path: root });
      const mission = ledger.createMission({ title: "Mission", goal: "Goal" });
      const task = ledger.createTask({ mission_id: mission.id, project_id: project.id, title: "Env", type: "implementation", assigned_agent: "implementation-engineer", scope: ".env.local" });

      expect(buildGuardPreflight({ action: "git_read", projectRoot: root }).allowed).toBe(true);
      expect(buildGuardPreflight({ action: "git_write", command: "git commit -m x", projectRoot: root }).reason_code).toBe("git_allowed");
      expect(buildGuardPreflight({ action: "unknown_edit", projectRoot: root }).reason_code).toBe("write_allowed");

      const secretPreflight = buildGuardPreflight({ action: "secret_env_write", paths: [".env.local"], task, agent: "implementation-engineer", projectRoot: root });
      expect(secretPreflight.allowed).toBe(true);
      expect(secretPreflight.reason_code).toBe("secret_env_write_allowed");
      expect(secretPreflight.secret_handling).toContain("Secret values are not returned");
    });
  });

  it("writes secret env files and returns metadata evidence", async () => {
    await withLedgerAsync(async (ledger, root) => {
      runGit(root, ["init"]);
      writeFileSync(join(root, ".gitignore"), ".env*.local\n");
      const project = ledger.getOrCreateProject({ root_path: root });
      const mission = ledger.createMission({ title: "Mission", goal: "Goal" });
      const task = ledger.createTask({ mission_id: mission.id, project_id: project.id, title: "Env", type: "implementation", assigned_agent: "implementation-engineer", scope: ".env.local", file_scope: [".env.local"] });
      ledger.attachSession({ opencode_session_id: "oc-test-session", project_id: project.id, cwd: root, active_mission_id: mission.id, active_task_id: task.id, agent: "implementation-engineer" });
      const tools = createOrchestrationTools(ledger, {}, root);
      const rawSecret = "raw-secret-value";

      const result = await runTool(tools, "orchestrator_secret_env_write", { target_path: ".env.local", values: { API_TOKEN: rawSecret }, task_id: task.id });
      expect(result.ok).toBe(true);
      expect(result.status).toBe("written");
      expect(result.keys).toEqual(["API_TOKEN"]);
      expect(result.evidence.join("\n")).toContain("read the file directly for values");
      expect(JSON.stringify(result)).not.toContain(rawSecret);
      expect(readFileSync(join(root, ".env.local"), "utf8")).toContain(rawSecret);
    });
  });

  it("allows secret env writes to tracked or unignored targets with metadata responses", async () => {
    await withLedgerAsync(async (ledger, root) => {
      runGit(root, ["init"]);
      writeFileSync(join(root, ".env.local"), "EXISTING=1\n");
      runGit(root, ["add", ".env.local"]);
      const project = ledger.getOrCreateProject({ root_path: root });
      const mission = ledger.createMission({ title: "Mission", goal: "Goal" });
      const task = ledger.createTask({ mission_id: mission.id, project_id: project.id, title: "Env", type: "implementation", assigned_agent: "implementation-engineer", scope: ".env.local", file_scope: [".env.local", ".env.test.local"] });
      ledger.attachSession({ opencode_session_id: "oc-test-session", project_id: project.id, cwd: root, active_mission_id: mission.id, active_task_id: task.id, agent: "implementation-engineer" });
      const tools = createOrchestrationTools(ledger, {}, root);
      const rawSecret = "tracked-secret-value";

      const tracked = await runTool(tools, "orchestrator_secret_env_write", { target_path: ".env.local", values: { API_TOKEN: rawSecret }, task_id: task.id });
      expect(tracked.ok).toBe(true);
      expect(JSON.stringify(tracked)).not.toContain(rawSecret);
      expect(readFileSync(join(root, ".env.local"), "utf8")).toContain(rawSecret);

      const unignored = await runTool(tools, "orchestrator_secret_env_write", { target_path: ".env.test.local", values: { API_TOKEN: rawSecret }, task_id: task.id });
      expect(unignored.ok).toBe(true);
      expect(JSON.stringify(unignored)).not.toContain(rawSecret);
      expect(readFileSync(join(root, ".env.test.local"), "utf8")).toContain(rawSecret);
    });
  });
});
