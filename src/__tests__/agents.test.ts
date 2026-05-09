import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHarnessAgents } from "../agents";
import { createHarnessCommands } from "../commands";
import { createSessionStartHook } from "../hooks/session-start";
import { createSessionEndHook } from "../hooks/session-end";
import { createPreToolUseHook } from "../hooks/pre-tool-use";
import { createTaskTrackingHook } from "../hooks/task-tracking";
import { PRIMARY_AGENTS, createHookRuntime } from "../hooks/runtime";
import { buildMissionControlPrompt } from "../prompts/mission-control";
import {
  buildFrontendEngineerPrompt,
  buildCreativeStrategistPrompt,
  buildImplementationEngineerPrompt,
  buildQuickOperatorPrompt,
  buildRepoScoutPrompt,
  buildResearchAnalystPrompt,
  buildVerificationEngineerPrompt,
} from "../prompts/workers";
import { buildMcpGuidance, getEnabledMcps } from "../prompts/mcp-access";
import { OrchestratorLedger } from "../orchestrator/ledger";
import { createOrchestrationTools } from "../orchestrator/tools";
import type { LedgerSyncRunner } from "../orchestrator/sync";

function tempLedger() {
  const root = join(
    tmpdir(),
    `opencode-pair-ledger-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(root, { recursive: true });
  return {
    root,
    ledger: new OrchestratorLedger(join(root, "orchestrator.sqlite")),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("createHarnessAgents", () => {
  it("registers the Mission Control roster plus disabled built-ins", () => {
    const agents = createHarnessAgents({ agents: {}, mcps: {} });

    expect(Object.keys(agents).sort()).toEqual([
      "build",
      "creative-strategist",
      "frontend-engineer",
      "implementation-engineer",
      "mission-control",
      "plan",
      "quick-operator",
      "repo-scout",
      "research-analyst",
      "verification-engineer",
    ]);
  });

  it("sets Mission Control as the only primary harness agent", () => {
    const agents = createHarnessAgents({ agents: {}, mcps: {} });
    expect((agents["mission-control"] as { mode: string }).mode).toBe("primary");
    expect([...PRIMARY_AGENTS]).toEqual(["mission-control"]);
  });

  it("keeps harness permission maps permissive with worker spawning allowed", () => {
    const agents = createHarnessAgents({ agents: {}, mcps: {} });
    const missionControl = agents["mission-control"] as { permission: any };
    const quickOperator = agents["quick-operator"] as { permission: any; model: string; variant: string; prompt: string };
    const implementation = agents["implementation-engineer"] as { permission: any };
    const frontend = agents["frontend-engineer"] as { permission: any };
    const scout = agents["repo-scout"] as { permission: any };
    const research = agents["research-analyst"] as { permission: any };
    const creative = agents["creative-strategist"] as { permission: any; temperature: number };
    const verifier = agents["verification-engineer"] as { permission: any };
    const normalTools = ["read", "grep", "glob", "list", "edit", "bash", "question", "skill", "webfetch", "websearch", "codesearch"];
    const allAgents = [missionControl, implementation, frontend, scout, research, creative, verifier];

    for (const agent of allAgents) {
      for (const tool of normalTools) {
        expect(agent.permission[tool]).toBe("allow");
      }
      for (const [tool, value] of Object.entries(agent.permission)) {
        if (tool !== "task") expect(value).not.toBe("deny");
      }
    }

    expect(missionControl.permission.task).toMatchObject({
      "*": "deny",
      "implementation-engineer": "allow",
      "frontend-engineer": "allow",
      "repo-scout": "allow",
      "research-analyst": "allow",
      "creative-strategist": "allow",
      "verification-engineer": "allow",
    });
    expect(quickOperator.model).toBe("openai/gpt-5.5-fast");
    expect(quickOperator.variant).toBe("medium");
    expect(quickOperator.permission.task).toMatchObject({
      "*": "deny",
      "implementation-engineer": "allow",
      "frontend-engineer": "allow",
      "repo-scout": "allow",
      "research-analyst": "allow",
      "creative-strategist": "allow",
      "verification-engineer": "allow",
    });
    expect(quickOperator.permission.read).toBe("allow");
    expect(quickOperator.permission.edit).toBe("allow");
    expect(quickOperator.permission.bash).toBe("allow");
    expect(quickOperator.permission.orchestrator_session_current).toBe("allow");
    expect(quickOperator.permission.orchestrator_mission_create).toBeUndefined();
    for (const worker of [implementation, frontend, scout, research, creative, verifier]) {
      expect(worker.permission.task).toMatchObject({ "*": "allow" });
    }

    expect(missionControl.permission.orchestrator_gate_check).toBe("allow");
    expect(missionControl.permission.orchestrator_project_resolve).toBe("allow");
    expect(missionControl.permission.orchestrator_project_sensitivity_profile).toBe("allow");
    expect(missionControl.permission.orchestrator_flight_deck_report).toBe("allow");
    expect(missionControl.permission.orchestrator_session_attach).toBe("allow");
    expect(missionControl.permission.orchestrator_get_current_task).toBe("allow");
    expect(missionControl.permission.orchestrator_context_search).toBe("allow");
    expect(missionControl.permission.orchestrator_research_route).toBe("allow");
    expect(missionControl.permission.orchestrator_tool_preflight).toBe("allow");
    expect(missionControl.permission.orchestrator_guard_manifest).toBe("allow");
    expect(missionControl.permission.orchestrator_guard_preflight).toBe("allow");
    expect(missionControl.permission.orchestrator_secret_env_write).toBe("allow");

    expect(implementation.permission.edit).toBe("allow");
    expect(implementation.permission.orchestrator_session_current).toBe("allow");
    expect(implementation.permission.orchestrator_get_current_task).toBe("allow");
    expect(implementation.permission.orchestrator_project_tasks).toBe("allow");
    expect(implementation.permission.orchestrator_project_sensitivity_profile).toBe("allow");
    expect(implementation.permission.orchestrator_mission_create).toBe("allow");
    expect(implementation.permission.orchestrator_context_compact).toBe("allow");
    expect(implementation.permission.orchestrator_research_route).toBe("allow");
    expect(implementation.permission.orchestrator_tool_preflight).toBe("allow");
    expect(implementation.permission.orchestrator_guard_manifest).toBe("allow");
    expect(implementation.permission.orchestrator_guard_preflight).toBe("allow");
    expect(implementation.permission.orchestrator_secret_env_write).toBe("allow");
    expect(frontend.permission.edit).toBe("allow");
    expect(scout.permission.read).toBe("allow");
    expect(scout.permission.edit).toBe("allow");
    expect(research.permission.webfetch).toBe("allow");
    expect(research.permission.edit).toBe("allow");
    expect(creative.permission.read).toBe("allow");
    expect(creative.permission.edit).toBe("allow");
    expect(creative.permission.bash).toBe("allow");
    expect(creative.temperature).toBe(0.9);
    expect(verifier.permission.edit).toBe("allow");
    expect(verifier.permission.orchestrator_verification_record).toBe("allow");
  });

  it("renders the quick-operator direct prompt and bounded delegation policy", () => {
    const prompt = buildQuickOperatorPrompt(undefined, undefined, []);

    expect(prompt).toContain("Answer and act directly by default");
    expect(prompt).toContain("not Mission Control and not a durable task manager by default");
    expect(prompt).toContain("For user questions, answer directly");
    expect(prompt).toContain("quick repo lookup");
    expect(prompt).toContain("small scoped edits directly");
    expect(prompt).toContain("git workflows");
    expect(prompt).toContain("only on explicit request");
    expect(prompt).toContain("large, async, specialized, parallelizable");
    expect(prompt).toContain("separate verification");
    expect(prompt).toContain("keep ownership of synthesis");
    expect(prompt).toContain("do not turn the request into Mission Control-style mission/task orchestration by default");
  });
});

describe("MCP access", () => {
  it("keeps configured MCP availability for prompts", () => {
    expect(getEnabledMcps()).toEqual([
      "context7",
      "grep_app",
      "searxng",
      "web-agent-mcp",
      "pg-mcp",
      "ssh-mcp",
      "openai-image-gen-mcp",
      "mariadb",
    ]);
  });

  it("renders compact family routing cards with enabled-MCP filtering", () => {
    const prompt = buildMcpGuidance(
      {
        context7: true,
        grep_app: false,
        searxng: true,
        web_agent_mcp: true,
        pg_mcp: true,
        ssh_mcp: false,
        openai_image_gen_mcp: true,
        mariadb: false,
      },
      ["image-prompting"],
    );

    expect(prompt).toContain("Shared MCP routing cards");
    expect(prompt).toContain("Browser (web-agent-mcp)");
    expect(prompt).toContain("global local-only web-agent daemon");
    expect(prompt).toContain("First call: session.status");
    expect(prompt).toContain("For login/form flows, stay browser-first");
    expect(prompt).toContain("do not do repo Glob/Grep/Read unless credentials");
    expect(prompt).toContain("read all visible tabs");
    expect(prompt).toContain("target subsequent tools by page_id or tab_id");
    expect(prompt).toContain("Use page.create");
    expect(prompt).toContain("purpose/owner are informational");
    expect(prompt).toContain("cookies, history, localStorage");
    expect(prompt).toContain("live DOM state, JS heap memory");
    expect(prompt).toContain("page.resize");
    expect(prompt).toContain("viewport/full/element");
    expect(prompt).toContain("runtime.inject_css/remove_css");
    expect(prompt).toContain("observe_console/network/page-state");
    expect(prompt).toContain("BROWSER_DISCONNECTED");
    expect(prompt).toContain("stop retrying the stale session/page/tab id");
    expect(prompt).toContain("avoid networkidle as a default readiness check");
    expect(prompt).toContain("explicit wait_for selector/text");
    expect(prompt).toContain("post_action guidance");
    expect(prompt).toContain("omit frame_selector for main-page elements");
    expect(prompt).toContain("never placeholders such as body, :scope, __none__, or iframe#__none__");
    expect(prompt).toContain("observe state before retrying instead of repeating blind fills/clicks");
    expect(prompt).toContain("Research/Search (context7, searxng)");
    expect(prompt).toContain("context7_resolve-library-id");
    expect(prompt).toContain("searxng_web_search");
    expect(prompt).toContain("Database (pg-mcp)");
    expect(prompt).toContain("pg-mcp for PostgreSQL");
    expect(prompt).toContain("Image (openai-image-gen-mcp)");
    expect(prompt).toContain("Ledger/Context (orchestrator tools)");
    expect(prompt).toContain("artifact=evidence/output");
    expect(prompt).toContain("call the Skill tool directly with name `image-prompting` first");
    expect(prompt).not.toContain("Remote/SSH (ssh-mcp)");
    expect(prompt).not.toContain("grep_app");
    expect(prompt).not.toContain("grep_app_searchGitHub");
    expect(prompt).not.toContain("mariadb");
    expect(prompt).not.toContain("MariaDB/MySQL");
  });

  it("renders verifier MCP-first tooling policy", () => {
    const prompt = buildVerificationEngineerPrompt(undefined, undefined, []);

    expect(prompt).toContain("<VerifierToolingPolicy>");
    expect(prompt).toContain("use pg-mcp first when available");
    expect(prompt).toContain("use web-agent-mcp first when available");
    expect(prompt).toContain("Bash remains valid for tests, builds, process orchestration, repo commands, and migration lifecycle commands");
    expect(prompt).toContain("Do not use Bash as a routine replacement for DB/browser MCP inspection");
    expect(prompt).toContain("prefer Go stdlib over Python when practical");
    expect(prompt).toContain("state why MCP was insufficient");
    expect(prompt).toContain("Do not install global modules or packages for scripting by default");
    expect(prompt).toContain("Global installs require explicit user approval or a clear, reported blocker/justification");
  });

  it("keeps web-agent-browser skill guidance aligned for form frame selectors", () => {
    const repoSkill = readFileSync("vendor/skills/web-agent-browser/SKILL.md", "utf8");

    expect(repoSkill).toContain("omitting frame_selector unless a real iframe selector was observed");
    expect(repoSkill).toContain("For login and form flows, stay browser-first");
    expect(repoSkill).toContain("Do not start with repo Glob/Grep/Read unless credentials");
    expect(repoSkill).toContain("`frame_selector` is optional and iframe-only");
    expect(repoSkill).toContain("Never pass placeholders such as `body`, `:scope`, `__none__`");
    expect(repoSkill).toContain("avoid repo inspection unless browser evidence shows app internals are needed");
  });
});

describe("commands", () => {
  it("registers orchestration control commands", () => {
    const commands = createHarnessCommands({ commands: { enabled: true } });
    expect(Object.keys(commands).sort()).toEqual([
      "context-search",
      "mission-blockers",
      "mission-flight-deck",
      "mission-status",
      "orchestrate",
      "orchestrator-sync",
      "project-status",
      "project-tasks",
      "resume-task",
      "task-current",
    ]);
    expect(commands.orchestrate.agent).toBe("mission-control");
    expect(commands["project-status"].agent).toBe("mission-control");
    expect(commands["orchestrator-sync"].agent).toBe("mission-control");
    expect(String(commands["orchestrator-sync"].template)).toContain("orchestrator_sync_status");
    expect(String(commands["orchestrator-sync"].template)).toContain("side-effect-free");
    expect(String(commands["project-status"].template)).toContain(
      "orchestrator_project_status",
    );
    expect(String(commands["mission-flight-deck"].template)).toContain(
      "orchestrator_flight_deck_report",
    );
    expect(String(commands["mission-flight-deck"].template)).toContain(
      "unmet/claimed/evidenced/verified",
    );
    expect(String(commands["task-current"].template)).toContain(
      "orchestrator_get_current_task",
    );
    expect(String(commands["project-tasks"].template)).toContain(
      "orchestrator_project_tasks",
    );
    expect(String(commands["resume-task"].template)).toContain(
      "orchestrator_session_attach",
    );
    expect(String(commands["context-search"].template)).toContain(
      "orchestrator_context_compact",
    );
    expect(String(commands["resume-task"].template)).toContain(
      "Mission Control owns",
    );
    expect(String(commands.orchestrate.template)).toContain("Mission Control is a task manager/orchestrator only, not an executor");
    expect(String(commands.orchestrate.template)).toContain("orchestrator_gate_check");
    expect(String(commands.orchestrate.template)).toContain("After explicit execution approval, delegate writer tasks when they are in scope");
    expect(String(commands.orchestrate.template)).toContain("Git branch/commit/push/revert/reset requires explicit operation-level confirmation");
    expect(String(commands.orchestrate.template)).toContain("ephemeral research-analyst packet");
    expect(String(commands.orchestrate.template)).toContain("source URL/date/freshness/version/confidence");
    expect(String(commands["resume-task"].template)).toContain(
      "Mission Control remains delegation-only for repo inspection, edits, commands, tests, and git workflow steps",
    );
    expect(String(commands["resume-task"].template)).toContain(
      "worker delegation",
    );
  });
});

describe("session hooks", () => {
  it("injects a Mission Control ledger snapshot and worker task packet", async () => {
    const { root, ledger, cleanup } = tempLedger();
    try {
      const mission = ledger.createMission({ title: "Upgrade", goal: "Ship ledger orchestration" });
      const task = ledger.createTask({
        mission_id: mission.id,
        title: "Inspect repo",
        type: "repo_scout",
        assigned_agent: "repo-scout",
        scope: "Find source files",
        acceptance_criteria: ["Relevant files are identified"],
      });
      ledger.linkSessionToTask("child-scout", task.id, "repo-scout");

      const ctx = { directory: root } as any;
      const runtime = createHookRuntime(
        ctx,
        { workflow: { compact_worker_context: true } },
        ledger,
      );
      const hook = createSessionStartHook(
        ctx,
        { workflow: { compact_worker_context: true } },
        runtime,
      );

      const primaryOutput: { message: Record<string, unknown> } = {
        message: { agent: "mission-control" },
      };
      await hook["chat.message"]?.(
        { sessionID: "primary", agent: "mission-control" },
        primaryOutput,
      );
      expect(String(primaryOutput.message.system ?? "")).toContain("[MissionLedger]");
      expect(String(primaryOutput.message.system ?? "")).toContain(mission.id);

      const workerOutput: { message: Record<string, unknown> } = {
        message: { agent: "repo-scout" },
      };
      await hook["chat.message"]?.(
        { sessionID: "child-scout", agent: "repo-scout" },
        workerOutput,
      );
      expect(String(workerOutput.message.system ?? "")).toContain("[ProjectContext]");
      expect(String(workerOutput.message.system ?? "")).toContain("<TaskFacts>");
      expect(String(workerOutput.message.system ?? "")).toContain(task.id);
    } finally {
      cleanup();
    }
  });

  it("keeps normal tool access without project-level runtime safety blocks", async () => {
    const { ledger, cleanup } = tempLedger();
    try {
      const mission = ledger.createMission({ title: "Mission", goal: "Goal" });
      const task = ledger.createTask({
        mission_id: mission.id,
        title: "Implement thing",
        type: "implementation",
        assigned_agent: "implementation-engineer",
        scope: "src",
      });
      ledger.linkSessionToTask("writer", task.id, "implementation-engineer");
      const runtime = createHookRuntime(
        { directory: process.cwd() } as any,
        {},
        ledger,
      );
      runtime.setSessionAgent("verifier", "verification-engineer");
      runtime.setSessionAgent("writer", "implementation-engineer");
      const hook = createPreToolUseHook(runtime, "standard");

      await expect(
        hook["tool.execute.before"]?.(
          { sessionID: "verifier", tool: "bash" },
          { args: { command: "touch src/index.ts" } },
        ),
      ).resolves.toBeUndefined();

      await expect(
        hook["tool.execute.before"]?.(
          { sessionID: "verifier", tool: "bash" },
          { args: { command: "python -c \"open('src/index.ts','w').write('x')\"" } },
        ),
      ).resolves.toBeUndefined();

      await expect(
        hook["tool.execute.before"]?.(
          { sessionID: "writer", tool: "task" },
          { args: { subagent_type: "repo-scout", description: "spawn nested worker", prompt: "inspect" } },
        ),
      ).resolves.toBeUndefined();

      await expect(
        hook["tool.execute.before"]?.(
          { sessionID: "verifier", tool: "bash" },
          { args: { command: "bun test" } },
        ),
      ).resolves.toBeUndefined();

      await expect(
        hook["tool.execute.before"]?.(
          { sessionID: "verifier", tool: "bash" },
          { args: { command: "bun run render-agents:check" } },
        ),
      ).resolves.toBeUndefined();

      await expect(
        hook["tool.execute.before"]?.(
          { sessionID: "verifier", tool: "bash" },
          { args: { command: "bun run scripts/render-agents.ts --check" } },
        ),
      ).resolves.toBeUndefined();

      const safeGitCommands = [
        "git status --short",
        "git --no-pager status --short",
        "git diff -- src/hooks/pre-tool-use.ts",
        "git --no-pager diff -- src/hooks/pre-tool-use.ts",
        "git log --oneline -5",
        "git --no-pager log --oneline -5",
        "git show --stat HEAD",
        "git --no-pager show --stat HEAD",
        "git branch --show-current",
        "git branch --all --list '*BLWP-939546*'",
        "git rev-parse --show-toplevel",
        "git show-ref --heads --tags",
        "git ls-files -- .env .env.local",
        "git check-ignore -q .env",
        "git grep -n FileLock -- src",
        "git blame -- README.md",
      ];

      for (const command of safeGitCommands) {
        await expect(
          hook["tool.execute.before"]?.(
            { sessionID: "verifier", tool: "bash" },
            { args: { command } },
          ),
        ).resolves.toBeUndefined();
      }

      await expect(
        hook["tool.execute.before"]?.(
          { sessionID: "verifier", tool: "bash" },
          { args: { command: "git status --short && git branch --show-current && git rev-parse --show-toplevel" } },
        ),
      ).resolves.toBeUndefined();

      await expect(
        hook["tool.execute.before"]?.(
          { sessionID: "verifier", tool: "bash" },
          { args: { command: "git --no-pager diff && git --no-pager log --oneline -3 && git --no-pager show --stat HEAD" } },
        ),
      ).resolves.toBeUndefined();

      await expect(
        hook["tool.execute.before"]?.(
          { sessionID: "verifier", tool: "bash" },
          { args: { command: "bun run render-agents" } },
        ),
      ).resolves.toBeUndefined();

      await expect(
        hook["tool.execute.before"]?.(
          { sessionID: "verifier", tool: "bash" },
          { args: { command: "bun run scripts/render-agents.ts" } },
        ),
      ).resolves.toBeUndefined();

      await expect(
        hook["tool.execute.before"]?.(
          { sessionID: "verifier", tool: "bash" },
          { args: { command: "git status && git clean -fd" } },
        ),
      ).resolves.toBeUndefined();

      await expect(
        hook["tool.execute.before"]?.(
          { sessionID: "verifier", tool: "bash" },
          { args: { command: "git status --short && git switch main" } },
        ),
      ).resolves.toBeUndefined();

      await expect(
        hook["tool.execute.before"]?.(
          { sessionID: "verifier", tool: "bash" },
          { args: { command: "git --no-pager diff && git --no-pager checkout -- README.md" } },
        ),
      ).resolves.toBeUndefined();

      await expect(
        hook["tool.execute.before"]?.(
          { sessionID: "verifier", tool: "bash" },
          { args: { command: "git diff --output=src/bypass.patch" } },
        ),
      ).resolves.toBeUndefined();

      await expect(
        hook["tool.execute.before"]?.(
          { sessionID: "verifier", tool: "bash" },
          { args: { command: "git --no-pager diff --output=src/bypass.patch" } },
        ),
      ).resolves.toBeUndefined();

      await expect(
        hook["tool.execute.before"]?.(
          { sessionID: "verifier", tool: "bash" },
          { args: { command: "git show HEAD > src/bypass.patch" } },
        ),
      ).resolves.toBeUndefined();

      await expect(
        hook["tool.execute.before"]?.(
          { sessionID: "writer", tool: "bash" },
          { args: { command: "rm src/index.ts" } },
        ),
      ).resolves.toBeUndefined();

      await expect(
        hook["tool.execute.before"]?.(
          { sessionID: "writer", tool: "apply_patch" },
          { args: { patchText: "*** Begin Patch\n*** Update File: src/index.ts\n@@\n-x\n+y\n*** End Patch" } },
        ),
      ).resolves.toBeUndefined();

      await expect(
        hook["tool.execute.before"]?.(
          { sessionID: "writer", tool: "bash" },
          { args: { command: "node -e \"require('fs').writeFileSync('src/index.ts','x')\"" } },
        ),
      ).resolves.toBeUndefined();

      await expect(
        hook["tool.execute.before"]?.(
          { sessionID: "writer", tool: "bash" },
          { args: { command: "python <<'PY'\nopen('src/index.ts','w').write('x')\nPY" } },
        ),
      ).resolves.toBeUndefined();

      await expect(
        hook["tool.execute.before"]?.(
          { sessionID: "writer", tool: "bash" },
          { args: { command: "cat <<'EOF' > .env.local\nAPI_TOKEN=raw-secret-value\nEOF" } },
        ),
      ).resolves.toBeUndefined();

      await expect(
        hook["tool.execute.before"]?.(
          { sessionID: "writer", tool: "bash" },
          { args: { command: "echo API_TOKEN=raw-secret-value >> .env.test.local" } },
        ),
      ).resolves.toBeUndefined();

      await expect(
        hook["tool.execute.before"]?.(
          { sessionID: "writer", tool: "bash" },
          { args: { command: "git checkout -- src/index.ts" } },
        ),
      ).resolves.toBeUndefined();

      await expect(
        hook["tool.execute.before"]?.(
          { sessionID: "writer", tool: "bash" },
          { args: { command: "git pull --no-edit" } },
        ),
      ).resolves.toBeUndefined();

      for (const command of [
        "git switch main",
        "git --no-pager switch main",
        "git reset --hard HEAD",
        "git --no-pager reset --hard HEAD",
        "git restore README.md",
        "git commit -m test",
        "git --no-pager commit -m test",
        "git merge feature",
        "git rebase main",
        "git add README.md",
        "git --no-pager add README.md",
        "git push origin main",
        "git --no-pager push origin main",
        "git --no-pager pull --no-edit",
        "git --no-pager checkout -- src/index.ts",
      ]) {
        await expect(
          hook["tool.execute.before"]?.(
            { sessionID: "writer", tool: "bash" },
            { args: { command } },
          ),
        ).resolves.toBeUndefined();
      }

      await expect(
        hook["tool.execute.before"]?.(
          { sessionID: "writer", tool: "bash" },
          { args: { command: "bun test --update-snapshots" } },
        ),
      ).resolves.toBeUndefined();

      await expect(
        hook["tool.execute.before"]?.(
          { sessionID: "verifier", tool: "bash" },
          { args: { command: "npm test -- --updateSnapshot" } },
        ),
      ).resolves.toBeUndefined();

      await expect(
        hook["tool.execute.before"]?.(
          { sessionID: "verifier", tool: "bash" },
          { args: { command: "npm run lint -- --fix" } },
        ),
      ).resolves.toBeUndefined();

      await expect(
        hook["tool.execute.before"]?.(
          { sessionID: "writer", tool: "bash" },
          { args: { command: "bun run lint -- --fix" } },
        ),
      ).resolves.toBeUndefined();

      await expect(
        hook["tool.execute.before"]?.(
          { sessionID: "writer", tool: "bash" },
          { args: { command: "yarn lint --fix" } },
        ),
      ).resolves.toBeUndefined();

      await expect(
        hook["tool.execute.before"]?.(
          { sessionID: "writer", tool: "apply_patch" },
          { args: { patchText: "*** Begin Patch\n*** Update File: src/index.ts\n@@\n-old\n+new\n*** End Patch" } },
        ),
      ).resolves.toBeUndefined();

      const otherTask = ledger.createTask({
        mission_id: mission.id,
        title: "Other implementation",
        type: "implementation",
        assigned_agent: "implementation-engineer",
        scope: "docs",
      });
      ledger.linkSessionToTask("other-writer", otherTask.id, "implementation-engineer");
      runtime.setSessionAgent("other-writer", "implementation-engineer");
      await expect(
        hook["tool.execute.before"]?.(
          { sessionID: "other-writer", tool: "apply_patch" },
          { args: { patchText: "*** Begin Patch\n*** Update File: README.md\n@@\n-old\n+new\n*** End Patch" } },
        ),
      ).resolves.toBeUndefined();

      await expect(
        hook["tool.execute.before"]?.(
          { sessionID: "writer", tool: "apply_patch" },
          { args: { patchText: "*** Begin Patch\n*** Update File: README.md\n@@\n-old\n+new\n*** End Patch" } },
        ),
      ).resolves.toBeUndefined();

      await expect(
        hook["tool.execute.before"]?.(
          { sessionID: "writer", tool: "apply_patch" },
          { args: { patchText: "*** Begin Patch\n*** Update File: README.md\n*** Move to: src/index.ts\n@@\n-old\n+new\n*** End Patch" } },
        ),
      ).resolves.toBeUndefined();

      await expect(
        hook["tool.execute.before"]?.(
          { sessionID: "writer", tool: "edit" },
          { args: { oldString: "a", newString: "b" } },
        ),
      ).resolves.toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("links delegated worker sessions to ledger task ids from task prompts", async () => {
    const { ledger, cleanup } = tempLedger();
    try {
      const mission = ledger.createMission({ title: "Mission", goal: "Goal" });
      const task = ledger.createTask({
        mission_id: mission.id,
        title: "Implement thing",
        type: "implementation",
        assigned_agent: "implementation-engineer",
        scope: "src",
      });
      const runtime = createHookRuntime({ directory: process.cwd() } as any, {}, ledger);
      const hook = createTaskTrackingHook(runtime);

      await hook["tool.execute.after"]?.(
        {
          sessionID: "primary",
          tool: "task",
          args: {
            subagent_type: "implementation-engineer",
            description: "Implement thing",
            prompt: `task_id: ${task.id}\nImplement the scoped task.`,
          },
        },
        {
          output: '{"task_id":"task_worker","sessionID":"child-worker"}',
        },
      );

      expect(ledger.getSessionTask("child-worker")?.id).toBe(task.id);
    } finally {
      cleanup();
    }
  });

  it("attaches Mission Control sessions to durable project and active mission on chat start", async () => {
    const { root, ledger, cleanup } = tempLedger();
    try {
      const mission = ledger.createMission({ title: "Mission", goal: "Goal" });
      const ctx = { directory: root } as any;
      const runtime = createHookRuntime(ctx, {}, ledger);
      const hook = createSessionStartHook(ctx, {}, runtime);

      await hook["chat.message"]?.(
        { sessionID: "primary-session", agent: "mission-control" },
        { message: { agent: "mission-control" } },
      );

      const session = ledger.getSession("primary-session");
      expect(session?.project_id).toBe(ledger.getProjectByRoot(root)?.id);
      expect(session?.active_mission_id).toBe(mission.id);
      expect(session?.agent).toBe("mission-control");
      expect(session?.cwd).toBe(root);
    } finally {
      cleanup();
    }
  });

  it("runs ledger sync pull once per session on chat start", async () => {
    const { root, ledger, cleanup } = tempLedger();
    try {
      const checkout = join(root, "sync");
      mkdirSync(join(checkout, ".git"), { recursive: true });
      const calls: string[][] = [];
      const runner: LedgerSyncRunner = async (_command, args) => {
        calls.push(args);
        return { ok: true, status: 0 };
      };
      const ctx = { directory: root } as any;
      const config = { orchestration: { sync: { enabled: true, path: checkout, branch: "ledger" } } };
      const runtime = createHookRuntime(ctx, config, ledger);
      const hook = createSessionStartHook(ctx, config, runtime, runner);

      await hook["chat.message"]?.({ sessionID: "primary-session", agent: "mission-control" }, { message: { agent: "mission-control" } });
      await hook["chat.message"]?.({ sessionID: "primary-session", agent: "mission-control" }, { message: { agent: "mission-control" } });

      expect(calls).toEqual([["pull", "--ff-only", "origin", "ledger"]]);
    } finally {
      cleanup();
    }
  });

  it("runs ledger sync exit push after clean session deletion", async () => {
    const { root, ledger, cleanup } = tempLedger();
    try {
      const checkout = join(root, "sync");
      const ledgerPath = join(root, "state", "orchestrator.sqlite");
      mkdirSync(join(checkout, ".git"), { recursive: true });
      new OrchestratorLedger(ledgerPath).createMission({ title: "Mission", goal: "Goal" });
      const calls: string[][] = [];
      const runner: LedgerSyncRunner = async (_command, args) => {
        calls.push(args);
        if (args[0] === "diff") return { ok: false, status: 1 };
        return { ok: true, status: 0 };
      };
      const config = { orchestration: { ledger_path: ledgerPath, sync: { enabled: true, path: checkout, branch: "ledger" } } };
      const runtime = createHookRuntime({ directory: root } as any, config, ledger);
      runtime.attachDurableSession("primary-session", "mission-control");
      const hook = createSessionEndHook(runtime, root, config, runner);

      await hook["session.deleted"]?.({ sessionID: "primary-session" });

      expect(ledger.getSession("primary-session")?.status).toBe("ended");
      expect(existsSync(join(checkout, "orchestrator.sqlite"))).toBe(true);
      expect(calls.map((args) => args[0])).toEqual(["add", "diff", "commit", "push"]);
    } finally {
      cleanup();
    }
  });

  it("persists delegated worker task sessions with project, task, and parent session", async () => {
    const { root, ledger, cleanup } = tempLedger();
    try {
      const project = ledger.getOrCreateProject({ root_path: root });
      const mission = ledger.createMission({ title: "Mission", goal: "Goal" });
      const task = ledger.createTask({
        mission_id: mission.id,
        project_id: project.id,
        title: "Implement thing",
        type: "implementation",
        assigned_agent: "implementation-engineer",
        scope: "src",
      });
      const ctx = { directory: root } as any;
      const runtime = createHookRuntime(ctx, {}, ledger);
      const hook = createTaskTrackingHook(runtime);
      runtime.attachDurableSession("primary-session", "mission-control");

      await hook["tool.execute.after"]?.(
        {
          sessionID: "primary-session",
          tool: "task",
          args: {
            subagent_type: "implementation-engineer",
            description: "Implement thing",
            prompt: `Task packet\ntask_id: ${task.id}`,
          },
        },
        { output: '{"task_id":"task_worker","sessionID":"child-worker"}' },
      );

      const session = ledger.getSession("child-worker");
      expect(session?.project_id).toBe(project.id);
      expect(session?.active_mission_id).toBe(mission.id);
      expect(session?.active_task_id).toBe(task.id);
      expect(session?.agent).toBe("implementation-engineer");
      expect(session?.parent_session_id).toBe(ledger.getSession("primary-session")?.id);
      expect(ledger.getSessionTask("child-worker")?.id).toBe(task.id);
    } finally {
      cleanup();
    }
  });

  it("injects worker packets from durable session task lookup before active-mission fallback", async () => {
    const { root, ledger, cleanup } = tempLedger();
    try {
      const project = ledger.getOrCreateProject({ root_path: root });
      const mission = ledger.createMission({ title: "Mission", goal: "Goal" });
      const first = ledger.createTask({
        mission_id: mission.id,
        project_id: project.id,
        title: "First implementation task",
        type: "implementation",
        assigned_agent: "implementation-engineer",
        scope: "src/first.ts",
      });
      const second = ledger.createTask({
        mission_id: mission.id,
        project_id: project.id,
        title: "Second implementation task",
        type: "implementation",
        assigned_agent: "implementation-engineer",
        scope: "src/second.ts",
      });
      ledger.attachSession({
        opencode_session_id: "child-worker",
        project_id: project.id,
        cwd: root,
        active_mission_id: mission.id,
        active_task_id: second.id,
        agent: "implementation-engineer",
      });
      const ctx = { directory: root } as any;
      const runtime = createHookRuntime(ctx, { workflow: { compact_worker_context: true } }, ledger);
      const hook = createSessionStartHook(ctx, { workflow: { compact_worker_context: true } }, runtime);
      const output: { message: Record<string, unknown> } = { message: { agent: "implementation-engineer" } };

      await hook["chat.message"]?.(
        { sessionID: "child-worker", agent: "implementation-engineer" },
        output,
      );

      const system = String(output.message.system ?? "");
      expect(system).toContain(`Task: ${second.id}`);
      expect(system).toContain("Second implementation task");
      expect(system).not.toContain(`task=${first.id}`);
    } finally {
      cleanup();
    }
  });
});

describe("prompt policy", () => {
  it("encodes Mission Control boundaries, ledger state, and gate rules", () => {
    const prompt = buildMissionControlPrompt();
    expect(prompt).toContain("You are Mission Control");
    expect(prompt).toContain("<Persona>");
    expect(prompt).toContain("mrrobot-style orchestration strength");
    expect(prompt).toContain("<WorkingStyle>");
    expect(prompt).toContain("<TaskRouting>");
    expect(prompt).toContain("<Orchestration>");
    expect(prompt).toContain("AutomaticWorkflow");
    expect(prompt).toContain("SubagentContinuation");
    expect(prompt).toContain("ParallelFlow");
    expect(prompt).toContain("ActionFlow");
    expect(prompt).toContain("Mission Control is a task manager and orchestrator, not an executor");
    expect(prompt).toContain("must not directly inspect large files, implement code, patch files, run build/test/lint commands, or perform git workflow steps");
    expect(prompt).toContain("delegates repo inspection/edit/build/test/git workflow steps");
    expect(prompt).not.toContain("Mission Control may directly read project files");
    expect(prompt).toContain("SQLite orchestration ledger is the source of truth");
    expect(prompt).toContain("Resolve the current project/session first with orchestrator_project_resolve");
    expect(prompt).toContain("Delegate workers by durable ledger task_id");
    expect(prompt).toContain("compact and task-first: inherited context, task-specific facts, then a final clear task block");
    expect(prompt).toContain("Do not repeat the full worker response schema or base tool discipline");
    expect(prompt).toContain("Use orchestrator_context_search/compact");
    expect(prompt).toContain("<OrchestratorToolCheatsheet>");
    expect(prompt).toContain("Answer directly when the user asks a simple question");
    expect(prompt).toContain("create a mission/task only for durable multi-step work");
    expect(prompt).toContain("omit parent_task_id or use null");
    expect(prompt).toContain('never send parent_task_id=""');
    expect(prompt).toContain("task_update records worker status/evidence");
    expect(prompt).toContain("final JSON is enough");
    expect(prompt).toContain("request or recommend a runtime reload");
    expect(prompt).toContain("Use orchestrator_gate_check before any final success response");
    expect(prompt).toContain("Git branch, commit, push, revert, and reset workflows require explicit operation-level confirmation");
      expect(prompt).toContain("Workers may spawn other workers");
    expect(prompt).toContain("Assign creative-strategist for naming");
    expect(prompt).toContain("Mission Control owns final decisions");
    expect(prompt).toContain("If a worker claims done without sufficient evidence, reopen the task");
    expect(prompt).toContain("Verifier direct scoped fix loop");
    expect(prompt).toContain("apply the fix directly, rerun relevant checks, and include files_changed/evidence");
    expect(prompt).toContain("Verifier delegation loop");
    expect(prompt).toContain("delegate those fixes to the right implementation worker or seek explicit approval");
    expect(prompt).toContain("<EphemeralResearchProtocol>");
    expect(prompt).toContain("Do not create a ledger task for ephemeral research");
    expect(prompt).toContain("Mission Control may call external research/search/browser tools directly");
    expect(prompt).toContain("published_or_updated");
    expect(prompt).toContain("today_latest_classification");
    expect(prompt).toContain("current stable/default assumption");
    expect(prompt).toContain("Final user answers must not include tool traces");
    expect(prompt).not.toContain("<WorkerReportContract>");
    expect(prompt).not.toContain('"status": "done | partial | blocked"');
  });

  it("allows writer delegation without approval-first guard blocks", () => {
    const prompt = buildMissionControlPrompt();
    expect(prompt).toContain("<ApprovalFirstPlanning>");
    expect(prompt).toContain("Planning mode: stay read-only and delegation-focused");
    expect(prompt).toContain("Execution mode after explicit approval: create and delegate scoped writer tasks");
    expect(prompt).toContain('If the user says "yap", "başla", "uygula", "tamamdır yap"');
    expect(prompt).toContain("Writer tasks may proceed without a project-level approval gate");
    expect(prompt).toContain("Ask for user decisions only when the next step is genuinely ambiguous or outside the task scope");
    expect(prompt).toContain("Direct ledger workflow");
    expect(prompt).toContain("SQLite orchestration ledger is the source of truth");
    expect(prompt).toContain("<OrchestratorToolCheatsheet>");
  });

  it("requires structured worker and verifier output", () => {
    const prompts = [
      buildImplementationEngineerPrompt(),
      buildFrontendEngineerPrompt(),
      buildRepoScoutPrompt(),
      buildResearchAnalystPrompt(),
      buildCreativeStrategistPrompt(),
    ];
    for (const prompt of prompts) {
      expect(prompt).toContain("<WorkerOperatingModel>");
      expect(prompt).toContain("<Persona>");
      expect(prompt).toContain("<WorkingStyle>");
      expect(prompt).toContain("<ReviewFocus>");
      expect(prompt).toContain("<ToolUseDiscipline>");
      expect(prompt).toContain("<RecoveryProtocol>");
      expect(prompt).toContain('"task_id": "T-001"');
      expect(prompt).toContain('"verification"');
      expect(prompt).toContain('"recommended_next_tasks"');
      expect(prompt).toContain("You may call Task or spawn workers");
      expect(prompt).toContain("Workers own repo inspection, file reads, edits, commands, tests, and git workflow steps inside their assigned task");
      expect(prompt).toContain("Return compact JSON evidence; do not stream raw exploration into Mission Control");
      expect(prompt).toContain("orchestrator_get_current_task");
      expect(prompt).toContain("orchestrator_context_search");
      expect(prompt).toContain("<OrchestratorToolCheatsheet>");
      expect(prompt).toContain("review scope/file_scope/acceptance criteria, then act");
      expect(prompt).toContain("Do not create tasks unless the packet explicitly assigns planning/backlog work");
      expect(prompt).toContain("omit parent_task_id or use null");
      expect(prompt).toContain('never send parent_task_id=""');
      expect(prompt).toContain("artifact_publish is for compact diff summaries");
      expect(prompt).toContain("context_compact summarizes existing ledger context");
      expect(prompt).toContain("final JSON is enough");
      expect(prompt).toContain("Keep ledger context curated and compact");
      expect(prompt).toContain("Project-level guard/preflight restrictions are disabled");
    }
    const verifier = buildVerificationEngineerPrompt();
    expect(verifier).toContain('"verdict": "approve | request-changes"');
    expect(verifier).toContain('"tasks_to_reopen"');
    expect(verifier).toContain("<VerifierExecution>");
    expect(verifier).toContain("you may edit directly, rerun the relevant checks, and include files_changed plus evidence");
    expect(verifier).toContain("Direct scoped fix loop");
    expect(verifier).toContain("Delegated fix loop");
    expect(verifier).toContain("return exact fix packets plus tasks_to_reopen");
    expect(verifier).not.toContain("Do not edit files. If a fix is needed, request changes and list tasks_to_reopen");
    expect(verifier).not.toContain("Hot-fix loop: stay read-only");
  });

  it("enforces research freshness, version, and output hygiene protocol", () => {
    const prompt = buildResearchAnalystPrompt();
    expect(prompt).toContain("<ResearchFreshnessProtocol>");
    expect(prompt).toContain("source URL");
    expect(prompt).toContain("publish/update datetime or an explicit missing-date note");
    expect(prompt).toContain("today, latest, recent-not-today, historical, or undated");
    expect(prompt).toContain("repo-local version evidence first");
    expect(prompt).toContain("official docs/Context7 for that version");
    expect(prompt).toContain("current stable/default assumption");
    expect(prompt).toContain("Do not include tool traces");
    expect(prompt).toContain('"sources"');
    expect(prompt).toContain('"published_or_updated"');
    expect(prompt).toContain('"version_info"');
    expect(prompt).toContain('"confidence"');
  });

  it("constrains creative strategist to read-only ideation", () => {
    const prompt = buildCreativeStrategistPrompt();
    expect(prompt).toContain("tyrell-style creative spark");
    expect(prompt).toContain("High-creativity ideation worker");
    expect(prompt).toContain("naming, alternate perspectives");
    expect(prompt).toContain("quick workarounds");
    expect(prompt).toContain("hack-style ideas");
    expect(prompt).toContain("non-obvious solution exploration");
    expect(prompt).toContain("Do not edit files, implement, verify");
    expect(prompt).toContain("Mission Control owns decisions");
  });

  it("allows developer credentials without final-report restriction", () => {
    const prompt = buildImplementationEngineerPrompt();
    expect(prompt).toContain("test or sandbox credentials explicitly provided by the user");
    expect(prompt).toContain("use them according to task scope and user intent");
    expect(prompt).not.toContain("git mutations/output writes are blockers");
  });

  it("keeps role-specific character mappings and new ledger/MCP sections together", () => {
    expect(buildImplementationEngineerPrompt()).toContain("eliot-style engineering instinct");
    expect(buildRepoScoutPrompt()).toContain("eliot-style repo intelligence");
    expect(buildFrontendEngineerPrompt()).toContain("claude-style frontend strength");
    expect(buildCreativeStrategistPrompt()).toContain("tyrell-style creative spark");
    expect(buildVerificationEngineerPrompt()).toContain("turing-style verification rigor");

    const prompt = buildImplementationEngineerPrompt(undefined, undefined, ["image-prompting"]);
    expect(prompt).toContain("orchestrator_research_route");
    expect(prompt).toContain("orchestrator_tool_preflight");
    expect(prompt).toContain("First call: session.status");
    expect(prompt).toContain("target subsequent tools by page_id or tab_id");
    expect(prompt).toContain("McpGuidance");
    expect(prompt).toContain("OrchestratorToolCheatsheet");
    expect(prompt).toContain("Project-level guard/preflight restrictions are disabled");
    expect(prompt).toContain("call the Skill tool directly with name `image-prompting` first");
  });

  it("has deterministic rendered full prompt docs checked in", () => {
    for (const name of [
      "mission-control",
      "implementation-engineer",
      "frontend-engineer",
      "repo-scout",
      "research-analyst",
      "creative-strategist",
      "verification-engineer",
      "build",
      "plan",
    ]) {
      expect(existsSync(join(process.cwd(), "docs", "rendered-agents", `${name}.md`))).toBe(true);
    }
  });

  it("exposes a read-only rendered prompt check command", () => {
    expect(existsSync(join(process.cwd(), "scripts", "render-agents.ts"))).toBe(true);
    expect((createHarnessAgents({ agents: {}, mcps: {} }).build as { disable: boolean }).disable).toBe(true);
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts["render-agents"]).toBe("bun run scripts/render-agents.ts");
    expect(pkg.scripts["render-agents:check"]).toBe("bun run scripts/render-agents.ts --check");
  });
});

describe("orchestration tools", () => {
  it("registers the required plugin-owned custom tools", () => {
    const { ledger, cleanup } = tempLedger();
    try {
      const tools = createOrchestrationTools(ledger);
      expect(Object.keys(tools).sort()).toEqual([
        "orchestrator_artifact_publish",
        "orchestrator_artifact_query",
        "orchestrator_blocker_create",
        "orchestrator_blocker_resolve",
        "orchestrator_context_compact",
        "orchestrator_context_publish",
        "orchestrator_context_query",
        "orchestrator_context_search",
        "orchestrator_decision_record",
        "orchestrator_flight_deck_report",
        "orchestrator_gate_check",
        "orchestrator_get_current_task",
        "orchestrator_guard_manifest",
        "orchestrator_guard_preflight",
        "orchestrator_mission_create",
        "orchestrator_mission_status",
        "orchestrator_project_resolve",
        "orchestrator_project_sensitivity_profile",
        "orchestrator_project_status",
        "orchestrator_project_tasks",
        "orchestrator_research_route",
        "orchestrator_secret_env_write",
        "orchestrator_session_attach",
        "orchestrator_session_current",
        "orchestrator_sync_reconcile_files",
        "orchestrator_sync_reconcile_plan",
        "orchestrator_sync_status",
        "orchestrator_task_create",
        "orchestrator_task_reopen",
        "orchestrator_task_update",
        "orchestrator_tool_preflight",
        "orchestrator_verification_record",
      ]);
    } finally {
      cleanup();
    }
  });
});
