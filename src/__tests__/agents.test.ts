import { describe, expect, it } from "bun:test";
import { createHarnessAgents } from "../agents";
import { createHarnessCommands } from "../commands";
import { buildCoordinatorPrompt } from "../prompts/coordinator";
import { DEFAULT_SKILL_SHORTLIST_TEXT } from "../prompts/shared";
import { buildEliotPrompt, buildTyrellPrompt } from "../prompts/workers";
import { getEnabledMcps } from "../prompts/mcp-access";

describe("createHarnessAgents", () => {
  it("registers mrrobot, eliot, tyrell, and validator plus disabled built-ins", () => {
    const agents = createHarnessAgents({ agents: {}, mcps: {} });

    expect(Object.keys(agents).sort()).toEqual([
      "build",
      "eliot",
      "mrrobot",
      "plan",
      "tyrell",
      "validator",
    ]);
  });

  it("keeps all harness agents unrestricted at the agent config layer", () => {
    const agents = createHarnessAgents({ agents: {}, mcps: {} });
    const mrrobot = agents.mrrobot as {
      mode: string;
      variant: string;
      permission?: unknown;
      tools?: unknown;
    };
    const eliot = agents.eliot as { permission?: unknown; tools?: unknown };
    const tyrell = agents.tyrell as {
      mode: string;
      variant: string;
      temperature?: unknown;
      hidden?: unknown;
      permission?: unknown;
      tools?: unknown;
    };
    const validator = agents.validator as {
      mode: string;
      variant: string;
      permission?: unknown;
      tools?: unknown;
    };

    expect(mrrobot.mode).toBe("primary");
    expect(mrrobot.variant).toBe("high");
    expect(mrrobot.permission).toBeUndefined();
    expect(mrrobot.tools).toBeUndefined();
    expect(eliot.permission).toBeUndefined();
    expect(eliot.tools).toBeUndefined();
    expect(tyrell.mode).toBe("subagent");
    expect(tyrell.variant).toBe("high");
    expect(tyrell.temperature).toBe(0.7);
    expect(tyrell.hidden).toBe(true);
    expect(tyrell.permission).toBeUndefined();
    expect(tyrell.tools).toBeUndefined();
    expect(validator.mode).toBe("subagent");
    expect(validator.variant).toBe("high");
    expect(validator.permission).toBeUndefined();
    expect(validator.tools).toBeUndefined();
  });
});

describe("MCP access", () => {
  it("enables the same configured MCP set for prompt-guided agents", () => {
    expect(getEnabledMcps()).toEqual([
      "context7",
      "grep_app",
      "searxng",
      "web-agent-mcp",
      "pg-mcp",
      "ssh-mcp",
      "mariadb",
    ]);
  });

  it("respects MCP toggles", () => {
    expect(
      getEnabledMcps({
        context7: false,
        web_agent_mcp: false,
        pg_mcp: true,
      }),
    ).toEqual(["grep_app", "searxng", "pg-mcp", "ssh-mcp", "mariadb"]);
  });
});

describe("createHarnessCommands", () => {
  it("removes harness slash-command wiring", () => {
    expect(createHarnessCommands({ commands: { enabled: true } })).toEqual({});
  });
});

describe("prompt policy", () => {
  it("requires external verification for framework and library guidance", () => {
    const coordinatorPrompt = buildCoordinatorPrompt();
    const workerPrompt = buildEliotPrompt();
    const tyrellPrompt = buildTyrellPrompt();

    for (const prompt of [coordinatorPrompt, workerPrompt, tyrellPrompt]) {
      expect(prompt).toContain(
        "For framework, library, API, or best-practice questions that are not fully settled by repository evidence, verify with external sources before answering.",
      );
      expect(prompt).toContain(
        "Prefer official documentation first (Context7 when available, otherwise official docs via web search). Use GitHub code search when real-world usage patterns matter.",
      );
      expect(prompt).toContain(
        "Do not present unsupported guesses about framework or library internals as facts. If you did not verify it, say that plainly.",
      );
    }
  });

  it("requires concrete task packets when delegating to subagents", () => {
    const prompt = buildCoordinatorPrompt();

    expect(prompt).toContain(
      "Use OpenCode Task for Eliot, Tyrell, and validator.",
    );
    expect(prompt).toContain(
      "Keep the mainline task with MrRobot unless delegation gives a clear advantage.",
    );
    expect(prompt).toContain(
      "When delegating, send a concrete packet with the goal, relevant files or search area, constraints, known evidence, and the exact output you expect back.",
    );
    expect(prompt).toContain(
      'Avoid vague assignments like "fix X" when repo evidence already lets you narrow the task.',
    );
    expect(prompt).toContain(
      "For research packets, specify which sources to inspect first and what decision or summary to return.",
    );
  });

  it("routes ideation work to tyrell without replacing Eliot as the default coding lane", () => {
    const coordinatorPrompt = buildCoordinatorPrompt();
    const eliotPrompt = buildEliotPrompt();
    const tyrellPrompt = buildTyrellPrompt();

    expect(coordinatorPrompt).toContain(
      "MrRobot owns the main task by default and should handle the primary implementation path directly when the work is clear, scoped, and reversible.",
    );
    expect(coordinatorPrompt).toContain(
      "Use Eliot for delegated support packets: scoped research, repo scouting, exact deliverables, parallel side work, or isolated implementation that should return a concrete result to MrRobot.",
    );
    expect(coordinatorPrompt).toContain(
      "Use tyrell for ideation packets, messy exploratory work, bug-hunting style exploration, long open-ended digging, naming, UX direction, product concepts, and alternative approaches.",
    );
    expect(coordinatorPrompt).toContain(
      "Do not treat Eliot or tyrell as the default lane for every implementation. Route only when delegation clearly helps.",
    );
    expect(eliotPrompt).toContain(
      "You are a scoped support lane, not the default owner of the user's whole task.",
    );
    expect(eliotPrompt).toContain(
      "Default to bounded investigations, exact deliverables, and isolated repo work that can be handed back cleanly.",
    );
    expect(tyrellPrompt).toContain("Tyrell — ideation-focused subagent.");
    expect(tyrellPrompt).toContain(
      "Do not invent facts, claim validation you did not do, or drift into default implementation mode unless MrRobot assigns that scope.",
    );
    expect(tyrellPrompt).toContain(
      "Handle ugly, open-ended, or long-running exploratory packets when MrRobot wants someone to dig through uncertainty.",
    );
    expect(coordinatorPrompt).toContain(
      "After any non-trivial code change, including MrRobot, Eliot, or Tyrell authored changes, run a validator pass unless the change was truly trivial and local.",
    );
    expect(coordinatorPrompt).toContain(
      "If validator requests changes, send the fix back to the original implementation lane, then run validator again.",
    );
  });

  it("encourages skill_find and a default installed skill shortlist", () => {
    const coordinatorPrompt = buildCoordinatorPrompt();
    const eliotPrompt = buildEliotPrompt();
    const tyrellPrompt = buildTyrellPrompt();

    const validatorPrompt = createHarnessAgents({ agents: {}, mcps: {} }).validator as {
      prompt: string;
    };

    for (const prompt of [
      coordinatorPrompt,
      eliotPrompt,
      tyrellPrompt,
      validatorPrompt.prompt,
    ]) {
      expect(prompt).toContain("skill_find");
      expect(prompt).toContain("skill_use");
      expect(prompt).toContain(DEFAULT_SKILL_SHORTLIST_TEXT);
    }
  });
});
