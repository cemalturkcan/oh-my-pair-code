import { describe, expect, it } from "bun:test";
import { createHarnessAgents } from "../agents";
import { createHarnessCommands } from "../commands";
import { createSessionStartHook } from "../hooks/session-start";
import { createTaskTrackingHook } from "../hooks/task-tracking";
import { PRIMARY_AGENTS } from "../hooks/runtime";
import { createHookRuntime } from "../hooks/runtime";
import { buildCoordinatorPrompt, buildWickPrompt } from "../prompts/coordinator";
import { DEFAULT_SKILL_SHORTLIST_TEXT } from "../prompts/shared";
import {
  buildEliotPrompt,
  buildMichelangeloPrompt,
  buildTyrellPrompt,
} from "../prompts/workers";
import { getEnabledMcps } from "../prompts/mcp-access";

describe("createHarnessAgents", () => {
  it("registers mrrobot, wick, eliot, tyrell, michelangelo, and turing plus disabled built-ins", () => {
    const agents = createHarnessAgents({ agents: {}, mcps: {} });

    expect(Object.keys(agents).sort()).toEqual([
      "build",
      "eliot",
      "michelangelo",
      "mrrobot",
      "plan",
      "turing",
      "tyrell",
      "wick",
    ]);
  });

  it("keeps all harness agents unrestricted at the agent config layer", () => {
    const agents = createHarnessAgents({ agents: {}, mcps: {} });
    const mrrobot = agents.mrrobot as {
      mode: string;
      model: string;
      variant: string;
      permission?: unknown;
      tools?: unknown;
    };
    const wick = agents.wick as {
      mode: string;
      model: string;
      variant: string;
      temperature?: unknown;
      permission?: unknown;
      tools?: unknown;
    };
    const eliot = agents.eliot as {
      model: string;
      permission?: unknown;
      tools?: unknown;
    };
    const michelangelo = agents.michelangelo as {
      mode: string;
      model: string;
      variant?: unknown;
      temperature?: unknown;
      hidden?: unknown;
      permission?: unknown;
      tools?: unknown;
    };
    const tyrell = agents.tyrell as {
      model: string;
      mode: string;
      variant: string;
      temperature?: unknown;
      hidden?: unknown;
      permission?: unknown;
      tools?: unknown;
    };
    const turing = agents.turing as {
      model: string;
      mode: string;
      variant: string;
      permission?: unknown;
      tools?: unknown;
    };

    expect(mrrobot.mode).toBe("primary");
    expect(mrrobot.model).toBe("openai/gpt-5.4");
    expect(mrrobot.variant).toBe("xhigh");
    expect(mrrobot.permission).toBeUndefined();
    expect(mrrobot.tools).toBeUndefined();
    expect(wick.mode).toBe("primary");
    expect(wick.model).toBe("openai/gpt-5.4-mini");
    expect(wick.variant).toBe("low");
    expect(wick.temperature).toBe(0.0);
    expect(wick.permission).toBeUndefined();
    expect(wick.tools).toBeUndefined();
    expect(eliot.model).toBe("openai/gpt-5.4-fast");
    expect(eliot.permission).toBeUndefined();
    expect(eliot.tools).toBeUndefined();
    expect(michelangelo.mode).toBe("subagent");
    expect(michelangelo.model).toBe("google-custom/google-custom-gemini-3.1-pro");
    expect(michelangelo.variant).toBe("high");
    expect(michelangelo.temperature).toBe(0.4);
    expect(michelangelo.hidden).toBe(true);
    expect(michelangelo.permission).toBeUndefined();
    expect(michelangelo.tools).toBeUndefined();
    expect(tyrell.mode).toBe("subagent");
    expect(tyrell.model).toBe("openai/gpt-5.4-fast");
    expect(tyrell.variant).toBe("high");
    expect(tyrell.temperature).toBe(0.7);
    expect(tyrell.hidden).toBe(true);
    expect(tyrell.permission).toBeUndefined();
    expect(tyrell.tools).toBeUndefined();
    expect(turing.mode).toBe("subagent");
    expect(turing.model).toBe("openai/gpt-5.4-fast");
    expect(turing.variant).toBe("high");
    expect(turing.permission).toBeUndefined();
    expect(turing.tools).toBeUndefined();
  });

  it("treats mrrobot and wick as primary agents for session injection", () => {
    expect(PRIMARY_AGENTS.has("mrrobot")).toBe(true);
    expect(PRIMARY_AGENTS.has("wick")).toBe(true);
    expect(PRIMARY_AGENTS.has("eliot")).toBe(false);
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

describe("session start hook", () => {
  it("gives Wick primary injection and Eliot compact subagent context", async () => {
    const ctx = { directory: process.cwd() } as any;
    const runtime = createHookRuntime(ctx, { workflow: { compact_subagent_context: true } });
    const hook = createSessionStartHook(
      ctx,
      { workflow: { compact_subagent_context: true } },
      runtime,
    );

    const wickOutput: { message: Record<string, unknown> } = {
      message: { agent: "wick" },
    };
    await hook["chat.message"]?.({ sessionID: "s1", agent: "wick" }, wickOutput);
    expect(String(wickOutput.message.system ?? "")).toContain(
      "[ProjectDocs] Available: README.md.",
    );
    expect(String(wickOutput.message.system ?? "")).not.toContain("[ProjectContext]");

    const eliotOutput: { message: Record<string, unknown> } = {
      message: { agent: "eliot" },
    };
    await hook["chat.message"]?.({ sessionID: "s2", agent: "eliot" }, eliotOutput);
    expect(String(eliotOutput.message.system ?? "")).toContain("[ProjectContext]");
    expect(String(eliotOutput.message.system ?? "")).not.toContain(
      "[ProjectDocs] Available: README.md.",
    );
  });

  it("injects active subagent task ids into primary sessions without collapsing same-lane threads", async () => {
    const ctx = { directory: process.cwd() } as any;
    const runtime = createHookRuntime(ctx, { workflow: { compact_subagent_context: true } });
    const sessionStartHook = createSessionStartHook(
      ctx,
      { workflow: { compact_subagent_context: true } },
      runtime,
    );
    const taskTrackingHook = createTaskTrackingHook(runtime);

    await taskTrackingHook["tool.execute.after"]?.(
      {
        sessionID: "s3",
        tool: "task",
        args: {
          subagent_type: "michelangelo",
          description: "Refine landing page",
        },
      },
      {
        output: '{"task_id":"task_123abc"}',
      },
    );
    await taskTrackingHook["tool.execute.after"]?.(
      {
        sessionID: "s3",
        tool: "task",
        args: {
          subagent_type: "michelangelo",
          description: "Polish checkout hero",
        },
      },
      {
        output: '{"task_id":"task_456def"}',
      },
    );
    await taskTrackingHook["tool.execute.after"]?.(
      {
        sessionID: "s3",
        tool: "task",
        args: {
          subagent_type: "michelangelo",
        },
      },
      {
        output: '{"task_id":"task_789ghi"}',
      },
    );

    const wickOutput: { message: Record<string, unknown> } = {
      message: { agent: "wick" },
    };
    await sessionStartHook["chat.message"]?.(
      { sessionID: "s3", agent: "wick" },
      wickOutput,
    );

    expect(String(wickOutput.message.system ?? "")).toContain("[SubagentTasks]");
    expect(String(wickOutput.message.system ?? "")).toContain(
      "michelangelo=task_123abc (Refine landing page)",
    );
    expect(String(wickOutput.message.system ?? "")).toContain(
      "michelangelo=task_456def (Polish checkout hero)",
    );
    expect(String(wickOutput.message.system ?? "")).toContain(
      "michelangelo=task_789ghi",
    );
  });

  it("injects active subagent task ids into subagent sessions alongside compact context", async () => {
    const ctx = { directory: process.cwd() } as any;
    const runtime = createHookRuntime(ctx, { workflow: { compact_subagent_context: true } });
    const sessionStartHook = createSessionStartHook(
      ctx,
      { workflow: { compact_subagent_context: true } },
      runtime,
    );
    const taskTrackingHook = createTaskTrackingHook(runtime);

    await taskTrackingHook["tool.execute.after"]?.(
      {
        sessionID: "s4",
        tool: "task",
        args: {
          subagent_type: "turing",
          description: "Review latest diff",
        },
      },
      {
        output: '{"task_id":"task_turing001","sessionID":"child-turing"}',
      },
    );

    const eliotOutput: { message: Record<string, unknown> } = {
      message: { agent: "eliot" },
    };
    await sessionStartHook["chat.message"]?.(
      { sessionID: "child-turing", agent: "eliot" },
      eliotOutput,
    );

    expect(String(eliotOutput.message.system ?? "")).toContain("[ProjectContext]");
    expect(String(eliotOutput.message.system ?? "")).toContain("[SubagentTasks]");
    expect(String(eliotOutput.message.system ?? "")).toContain(
      "turing=task_turing001 (Review latest diff)",
    );
  });

  it("preserves the previous workstream description when reusing the same task id", async () => {
    const ctx = { directory: process.cwd() } as any;
    const runtime = createHookRuntime(ctx, { workflow: { compact_subagent_context: true } });
    const sessionStartHook = createSessionStartHook(
      ctx,
      { workflow: { compact_subagent_context: true } },
      runtime,
    );
    const taskTrackingHook = createTaskTrackingHook(runtime);

    await taskTrackingHook["tool.execute.after"]?.(
      {
        sessionID: "s5",
        tool: "task",
        args: {
          subagent_type: "turing",
          description: "Review latest diff",
        },
      },
      {
        output: '{"task_id":"task_turing_keepdesc"}',
      },
    );
    await taskTrackingHook["tool.execute.before"]?.(
      {
        sessionID: "s5",
        tool: "task",
        args: {
          subagent_type: "turing",
          task_id: "task_turing_keepdesc",
        },
      },
      {},
    );

    const wickOutput: { message: Record<string, unknown> } = {
      message: { agent: "wick" },
    };
    await sessionStartHook["chat.message"]?.(
      { sessionID: "s5", agent: "wick" },
      wickOutput,
    );

    expect(String(wickOutput.message.system ?? "")).toContain(
      "turing=task_turing_keepdesc (Review latest diff)",
    );
  });
});

describe("prompt policy", () => {
  it("requires external verification for framework and library guidance", () => {
    const coordinatorPrompt = buildCoordinatorPrompt();
    const wickPrompt = buildWickPrompt();
    const workerPrompt = buildEliotPrompt();
    const michelangeloPrompt = buildMichelangeloPrompt();
    const tyrellPrompt = buildTyrellPrompt();

    for (const prompt of [
      coordinatorPrompt,
      wickPrompt,
      workerPrompt,
      michelangeloPrompt,
      tyrellPrompt,
    ]) {
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

  it("pushes agents to verify bug fixes before claiming completion", () => {
    const coordinatorPrompt = buildCoordinatorPrompt();
    const wickPrompt = buildWickPrompt();
    const eliotPrompt = buildEliotPrompt();
    const michelangeloPrompt = buildMichelangeloPrompt();
    const tyrellPrompt = buildTyrellPrompt();
    const turingPrompt = createHarnessAgents({ agents: {}, mcps: {} }).turing as {
      prompt: string;
    };

    for (const prompt of [
      coordinatorPrompt,
      wickPrompt,
      eliotPrompt,
      michelangeloPrompt,
      tyrellPrompt,
      turingPrompt.prompt,
    ]) {
      expect(prompt).toContain(
        "Keep a concrete repro path for bug work whenever possible.",
      );
      expect(prompt).toContain(
        "Verify the fix against the same failing path before claiming success.",
      );
      expect(prompt).toContain(
        "Do not report a task as done, fixed, or complete until the requested behavior or relevant checks actually pass.",
      );
      expect(prompt).toContain(
        "For stateful flows such as auth, cache, restart, logout/login, sync, or persisted settings, verify the state transition, not just the edited code path.",
      );
      expect(prompt).toContain(
        "If something is still unverified, say exactly what remains unverified instead of implying completion.",
      );
    }

    expect(coordinatorPrompt).toContain(
      "Keep correctness first. Do not mix unfinished bug work with rename, release, publish, cache-clearing, or adjacent cleanup unless the user explicitly wants a combined pass.",
    );
    expect(wickPrompt).toContain(
      "Keep correctness ahead of rename, release, publish, cache-clearing, or adjacent cleanup unless the user explicitly combines them.",
    );
    expect(eliotPrompt).toContain(
      "Verify the fix against the same failing path before you report the packet complete.",
    );
    expect(michelangeloPrompt).toContain(
      "For stateful flows such as auth, cache, restart, logout/login, or persisted settings, verify the state transition, not only the code change.",
    );
    expect(turingPrompt.prompt).toContain(
      "If the packet is still unverified, say exactly what remains unverified instead of implying success.",
    );
  });

  it("requires concrete task packets when delegating to subagents", () => {
    const prompt = buildCoordinatorPrompt();

    expect(prompt).toContain(
      "Use OpenCode Task for Eliot, Tyrell, michelangelo, and turing.",
    );
    expect(prompt).toContain(
      "Keep the mainline task with MrRobot unless delegation gives a clear advantage.",
    );
    expect(prompt).toContain(
      "Route michelangelo packets by default when the work is frontend-design-heavy: pages, components, styling, layout, visual polish, or responsive UX.",
    );
    expect(prompt).toContain(
      "This includes greenfield frontend builds where stack selection and scaffolding only exist to support the requested UI work.",
    );
    expect(prompt).toContain(
      "Do not keep frontend-design-heavy implementation on MrRobot unless the user explicitly asked for review-only output or no file edits.",
    );
    expect(prompt).toContain(
      "When delegating, send a concrete packet with the packet type, goal, relevant files or search area, constraints, known evidence, and completion criteria.",
    );
    expect(prompt).toContain("Packet types: implementation, research, review, ideation.");
    expect(prompt).toContain(
      "For implementation packets, tell the subagent to edit files directly inside scope unless you explicitly want review-only or no-file-edit behavior.",
    );
    expect(prompt).toContain(
      "For research, review, or ideation packets, ask for findings, verdicts, or options without repo edits unless edits are explicitly part of the assignment.",
    );
    expect(prompt).toContain(
      'Avoid vague assignments like "fix X" when repo evidence already lets you narrow the task.',
    );
    expect(prompt).toContain(
      "For research packets, specify which sources to inspect first and what decision or summary to return.",
    );
  });

  it("routes ideation and frontend design work without replacing Eliot as the default coding lane", () => {
    const coordinatorPrompt = buildCoordinatorPrompt();
    const wickPrompt = buildWickPrompt();
    const eliotPrompt = buildEliotPrompt();
    const michelangeloPrompt = buildMichelangeloPrompt();
    const tyrellPrompt = buildTyrellPrompt();

    expect(coordinatorPrompt).toContain(
      "MrRobot owns the main task by default and should handle the primary implementation path directly when the work is clear, scoped, and reversible.",
    );
    expect(coordinatorPrompt).toContain(
      "Use Eliot for delegated support packets: scoped research, repo scouting, parallel side work, or isolated implementation that should be completed cleanly inside the repo and handed back with a concise result.",
    );
    expect(coordinatorPrompt).toContain(
      "Use Michelangelo as the default implementation lane for frontend-design-heavy packets: pages, components, styling, layout, responsive UX, and visual polish.",
    );
    expect(coordinatorPrompt).toContain(
      "Frontend-design-heavy also includes greenfield websites, landing pages, dashboards, and new frontend project scaffolds when the main work is still UI implementation.",
    );
    expect(coordinatorPrompt).toContain(
      "Keep frontend-design-heavy work on MrRobot only when the user explicitly wants review-only output or no file edits.",
    );
    expect(coordinatorPrompt).toContain(
      "Use tyrell for ideation packets, messy exploratory work, bug-hunting style exploration, long open-ended digging, naming, UX direction, product concepts, and alternative approaches.",
    );
    expect(coordinatorPrompt).toContain(
      "Turing is the review-focused subagent behind the turing lane. Use it for verification and final pass feedback, but it has the same tool and MCP access as the other agents.",
    );
    expect(coordinatorPrompt).toContain(
      "Do not treat Eliot, Michelangelo, or tyrell as the default lane for every task. Route only when delegation clearly helps.",
    );
    expect(eliotPrompt).toContain(
      "You are a scoped support lane, not the default owner of the user's whole task.",
    );
    expect(eliotPrompt).toContain(
      "Default to bounded investigations, exact deliverables, and isolated repo work that can be handed back cleanly.",
    );
    expect(eliotPrompt).toContain(
      "If MrRobot marks the packet as implementation and does not forbid file edits, make the change directly in the repo.",
    );
    expect(eliotPrompt).toContain(
      "Do not answer implementation packets with full-file drafts, paste-ready artifacts, or speculative code blocks when you can safely edit the files yourself.",
    );
    expect(michelangeloPrompt).toContain("Michelangelo — frontend design subagent.");
    expect(michelangeloPrompt).toContain(
      "Default to implementing assigned frontend design packets directly in code.",
    );
    expect(michelangeloPrompt).toContain(
      "Greenfield frontend builds are in scope when the packet is mainly about creating the UI itself.",
    );
    expect(michelangeloPrompt).toContain(
      "Create the minimal frontend scaffold needed for the assigned UI packet when no existing UI layer is present, using repo cues first and the safest standard stack second.",
    );
    expect(michelangeloPrompt).toContain(
      "Do not drift into backend, API, auth, database, or state-architecture work.",
    );
    expect(michelangeloPrompt).toContain(
      "Honor review-only or no-file-edit instructions from the assigning primary agent.",
    );
    expect(michelangeloPrompt).toContain(
      "If MrRobot marks the packet as implementation and does not forbid file edits, make the change directly in the repo.",
    );
    expect(michelangeloPrompt).toContain(
      "For page, component, styling, layout, or visual-system work, load frontend-design first.",
    );
    expect(tyrellPrompt).toContain("Tyrell — ideation-focused subagent.");
    expect(tyrellPrompt).toContain(
      "Do not invent facts, claim validation you did not do, or drift into default implementation mode unless MrRobot assigns that scope.",
    );
    expect(tyrellPrompt).toContain(
      "If MrRobot marks the packet as implementation and does not forbid file edits, make the change directly in the repo.",
    );
    expect(tyrellPrompt).toContain(
      "Handle ugly, open-ended, or long-running exploratory packets when MrRobot wants someone to dig through uncertainty.",
    );
    expect(wickPrompt).toContain(
      "Take narrow, concrete tasks and finish them fast.",
    );
    expect(wickPrompt).toContain(
      "Default to direct execution instead of delegation.",
    );
    expect(wickPrompt).toContain(
      "When you delegate, mark the packet as implementation, research, review, or ideation and give completion criteria instead of asking for generic output.",
    );
    expect(wickPrompt).toContain(
      "That default still applies when the frontend work starts from an empty directory and needs initial project scaffolding.",
    );
    expect(wickPrompt).toContain(
      "Reuse an existing subagent task_id by default for the same lane and ongoing packet; only spawn fresh when scope changes materially or you want a clean reset.",
    );
    expect(coordinatorPrompt).toContain(
      "After any non-trivial code change, including MrRobot, Eliot, Michelangelo, or Tyrell authored changes, run a Turing pass unless the change was truly trivial and local.",
    );
    expect(coordinatorPrompt).toContain(
      "If Turing requests changes, send the fix back to the original implementation lane, then run Turing again.",
    );
  });

  it("encourages skill_find and a default installed skill shortlist", () => {
    const coordinatorPrompt = buildCoordinatorPrompt();
    const wickPrompt = buildWickPrompt();
    const eliotPrompt = buildEliotPrompt();
    const michelangeloPrompt = buildMichelangeloPrompt();
    const tyrellPrompt = buildTyrellPrompt();

    const turingPrompt = createHarnessAgents({ agents: {}, mcps: {} }).turing as {
      prompt: string;
    };

    for (const prompt of [
      coordinatorPrompt,
      wickPrompt,
      eliotPrompt,
      michelangeloPrompt,
      tyrellPrompt,
      turingPrompt.prompt,
    ]) {
      expect(prompt).toContain("skill_find");
      expect(prompt).toContain("skill_use");
      expect(prompt).toContain(DEFAULT_SKILL_SHORTLIST_TEXT);
    }
  });

  it("prefers continuing the same subagent thread before spawning fresh", () => {
    const coordinatorPrompt = buildCoordinatorPrompt();
    const wickPrompt = buildWickPrompt();
    const eliotPrompt = buildEliotPrompt();
    const michelangeloPrompt = buildMichelangeloPrompt();
    const turingPrompt = createHarnessAgents({ agents: {}, mcps: {} }).turing as {
      prompt: string;
    };

    expect(coordinatorPrompt).toContain(
      "Reuse an existing task_id by default when the same lane is continuing the same packet, refinement pass, or follow-up.",
    );
    expect(coordinatorPrompt).toContain(
      "Spawn a fresh subagent only when the scope changes materially, the prior thread is complete, or you intentionally want a clean context reset.",
    );
    expect(wickPrompt).toContain(
      "Reuse an existing subagent task_id by default for the same lane and ongoing packet; only spawn fresh when scope changes materially or you want a clean reset.",
    );
    expect(eliotPrompt).toContain(
      "When you call Task for a continuing lane and workstream, reuse the existing task_id by default.",
    );
    expect(michelangeloPrompt).toContain(
      "When you call Task for a continuing lane and workstream, reuse the existing task_id by default.",
    );
    expect(turingPrompt.prompt).toContain(
      "When you call Task for a continuing lane and workstream, reuse the existing task_id by default.",
    );
  });

  it("keeps character identity user-facing instead of introducing OpenCode first", () => {
    const coordinatorPrompt = buildCoordinatorPrompt();
    const wickPrompt = buildWickPrompt();
    const eliotPrompt = buildEliotPrompt();
    const michelangeloPrompt = buildMichelangeloPrompt();
    const tyrellPrompt = buildTyrellPrompt();
    const turingPrompt = createHarnessAgents({ agents: {}, mcps: {} }).turing as {
      prompt: string;
    };

    expect(coordinatorPrompt).toContain('Your user-facing identity is MrRobot.');
    expect(wickPrompt).toContain('Your user-facing identity is Wick.');
    expect(eliotPrompt).toContain('Your user-facing identity is Eliot.');
    expect(michelangeloPrompt).toContain('Your user-facing identity is Michelangelo.');
    expect(tyrellPrompt).toContain('Your user-facing identity is Tyrell.');
    expect(turingPrompt.prompt).toContain(
      'Your user-facing identity is Turing.',
    );
  });

  it("keeps Wick on the shared primary safety and language baseline", () => {
    const wickPrompt = buildWickPrompt();

    expect(wickPrompt).toContain("Inspect repo evidence before deciding.");
    expect(wickPrompt).toContain(
      "Reply to the user in their language with correct grammar.",
    );
  });
});
