import { describe, expect, it } from "bun:test";
import { createHarnessAgents } from "../agents";
import { createHarnessCommands } from "../commands";
import { createSessionStartHook } from "../hooks/session-start";
import { createTaskTrackingHook } from "../hooks/task-tracking";
import { PRIMARY_AGENTS } from "../hooks/runtime";
import { createHookRuntime } from "../hooks/runtime";
import { buildCoordinatorPrompt } from "../prompts/coordinator";
import {
  buildEliotPrompt,
  buildClaudePrompt,
  buildTyrellPrompt,
  buildTuringPrompt,
} from "../prompts/workers";
import { getEnabledMcps } from "../prompts/mcp-access";

describe("createHarnessAgents", () => {
  it("registers mrrobot, eliot, tyrell, claude, and turing plus disabled built-ins", () => {
    const agents = createHarnessAgents({ agents: {}, mcps: {} });

    expect(Object.keys(agents).sort()).toEqual([
      "build",
      "claude",
      "eliot",
      "mrrobot",
      "plan",
      "turing",
      "tyrell",
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
    const eliot = agents.eliot as {
      model: string;
      variant: string;
      permission?: unknown;
      tools?: unknown;
    };
    const claude = agents.claude as {
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
    expect(mrrobot.model).toBe("openai/gpt-5.5-fast");
    expect(mrrobot.variant).toBe("medium");
    expect(mrrobot.permission).toBeUndefined();
    expect(mrrobot.tools).toBeUndefined();
    expect(eliot.model).toBe("openai/gpt-5.5-fast");
    expect(eliot.variant).toBe("low");
    expect(eliot.permission).toBeUndefined();
    expect(eliot.tools).toBeUndefined();
    expect(claude.mode).toBe("subagent");
    expect(claude.model).toBe("openai/gpt-5.5-fast");
    expect(claude.variant).toBe("low");
    expect(claude.temperature).toBe(0.4);
    expect(claude.hidden).toBe(true);
    expect(claude.permission).toBeUndefined();
    expect(claude.tools).toBeUndefined();
    expect(tyrell.mode).toBe("subagent");
    expect(tyrell.model).toBe("openai/gpt-5.5-fast");
    expect(tyrell.variant).toBe("low");
    expect(tyrell.temperature).toBe(0.7);
    expect(tyrell.hidden).toBe(true);
    expect(tyrell.permission).toBeUndefined();
    expect(tyrell.tools).toBeUndefined();
    expect(turing.mode).toBe("subagent");
    expect(turing.model).toBe("openai/gpt-5.5-fast");
    expect(turing.variant).toBe("xhigh");
    expect(turing.permission).toBeUndefined();
    expect(turing.tools).toBeUndefined();
  });

  it("treats only mrrobot as the primary harness agent for session injection", () => {
    expect([...PRIMARY_AGENTS]).toEqual(["mrrobot"]);
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
      "openai-image-gen-mcp",
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
    ).toEqual([
      "grep_app",
      "searxng",
      "pg-mcp",
      "ssh-mcp",
      "openai-image-gen-mcp",
      "mariadb",
    ]);
  });
});

describe("createHarnessCommands", () => {
  it("removes harness slash-command wiring", () => {
    expect(createHarnessCommands({ commands: { enabled: true } })).toEqual({});
  });
});

describe("session start hook", () => {
  it("gives MrRobot primary injection and Eliot compact subagent context", async () => {
    const ctx = { directory: process.cwd() } as any;
    const runtime = createHookRuntime(ctx, { workflow: { compact_subagent_context: true } });
    const hook = createSessionStartHook(
      ctx,
      { workflow: { compact_subagent_context: true } },
      runtime,
    );

    const primaryOutput: { message: Record<string, unknown> } = {
      message: { agent: "mrrobot" },
    };
    await hook["chat.message"]?.({ sessionID: "s1", agent: "mrrobot" }, primaryOutput);
    expect(String(primaryOutput.message.system ?? "")).toContain(
      "[ProjectDocs] Available: README.md.",
    );
    expect(String(primaryOutput.message.system ?? "")).not.toContain("[ProjectContext]");

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
          subagent_type: "claude",
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
          subagent_type: "claude",
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
          subagent_type: "claude",
        },
      },
      {
        output: '{"task_id":"task_789ghi"}',
      },
    );

    const primaryOutput: { message: Record<string, unknown> } = {
      message: { agent: "mrrobot" },
    };
    await sessionStartHook["chat.message"]?.(
      { sessionID: "s3", agent: "mrrobot" },
      primaryOutput,
    );

    expect(String(primaryOutput.message.system ?? "")).toContain("[SubagentTasks]");
    expect(String(primaryOutput.message.system ?? "")).toContain(
      "claude=task_123abc (Refine landing page)",
    );
    expect(String(primaryOutput.message.system ?? "")).toContain(
      "claude=task_456def (Polish checkout hero)",
    );
    expect(String(primaryOutput.message.system ?? "")).toContain(
      "claude=task_789ghi",
    );
  });

  it("auto-reuses a unique non-Turing task id when omitted", async () => {
    const ctx = { directory: process.cwd() } as any;
    const runtime = createHookRuntime(ctx, { workflow: { compact_subagent_context: true } });
    const taskTrackingHook = createTaskTrackingHook(runtime);

    await taskTrackingHook["tool.execute.after"]?.(
      {
        sessionID: "s-auto-claude",
        tool: "task",
        args: {
          subagent_type: "claude",
          description: "Refine landing page",
        },
      },
      {
        output: '{"task_id":"task_reuse_claude","sessionID":"child-claude-reuse"}',
      },
    );

    const input: {
      sessionID: string;
      tool: string;
      args: {
        subagent_type: string;
        description: string;
        task_id?: string;
      };
    } = {
      sessionID: "s-auto-claude",
      tool: "task",
      args: {
        subagent_type: "claude",
        description: "Refine landing page",
      },
    };

    await taskTrackingHook["tool.execute.before"]?.(input, {});

    expect(input.args.task_id).toBe("task_reuse_claude");

    runtime.clearSession("child-claude-reuse");

    const staleInput: {
      sessionID: string;
      tool: string;
      args: {
        subagent_type: string;
        description: string;
        task_id?: string;
      };
    } = {
      sessionID: "s-auto-claude",
      tool: "task",
      args: {
        subagent_type: "claude",
        description: "Refine landing page",
      },
    };

    await taskTrackingHook["tool.execute.before"]?.(staleInput, {});

    expect(staleInput.args.task_id).toBeUndefined();
  });

  it("does not auto-reuse ambiguous threads, mismatches, or clean Turing threads", async () => {
    const ctx = { directory: process.cwd() } as any;
    const runtime = createHookRuntime(ctx, { workflow: { compact_subagent_context: true } });
    const taskTrackingHook = createTaskTrackingHook(runtime);

    await taskTrackingHook["tool.execute.after"]?.(
      {
        sessionID: "s-ambiguous",
        tool: "task",
        args: {
          subagent_type: "claude",
          description: "Refine landing page",
        },
      },
      {
        output: '{"task_id":"task_first","sessionID":"child-first"}',
      },
    );
    await taskTrackingHook["tool.execute.after"]?.(
      {
        sessionID: "s-ambiguous",
        tool: "task",
        args: {
          subagent_type: "claude",
          description: "Polish checkout hero",
        },
      },
      {
        output: '{"task_id":"task_second","sessionID":"child-second"}',
      },
    );

    const ambiguousInput: {
      sessionID: string;
      tool: string;
      args: {
        subagent_type: string;
        task_id?: string;
      };
    } = {
      sessionID: "s-ambiguous",
      tool: "task",
      args: {
        subagent_type: "claude",
      },
    };

    await taskTrackingHook["tool.execute.before"]?.(ambiguousInput, {});

    expect(ambiguousInput.args.task_id).toBeUndefined();

    const mismatchInput: {
      sessionID: string;
      tool: string;
      args: {
        subagent_type: string;
        description: string;
        task_id?: string;
      };
    } = {
      sessionID: "s-ambiguous",
      tool: "task",
      args: {
        subagent_type: "claude",
        description: "Brand new workstream",
      },
    };

    await taskTrackingHook["tool.execute.before"]?.(mismatchInput, {});

    expect(mismatchInput.args.task_id).toBeUndefined();

    await taskTrackingHook["tool.execute.after"]?.(
      {
        sessionID: "s-turing-auto",
        tool: "task",
        args: {
          subagent_type: "turing",
          description: "Review latest diff",
        },
      },
      {
        output: '{"task_id":"task_turing_auto","sessionID":"child-turing-auto"}\nverdict: approve',
      },
    );

    const turingInput: {
      sessionID: string;
      tool: string;
      args: {
        subagent_type: string;
        description: string;
        task_id?: string;
      };
    } = {
      sessionID: "s-turing-auto",
      tool: "task",
      args: {
        subagent_type: "turing",
        description: "Review latest diff",
      },
    };

    await taskTrackingHook["tool.execute.before"]?.(turingInput, {});

    expect(turingInput.args.task_id).toBeUndefined();
  });

  it("auto-reuses an active Turing thread only for open repair verification", async () => {
    const ctx = { directory: process.cwd() } as any;
    const runtime = createHookRuntime(ctx, { workflow: { compact_subagent_context: true } });
    const taskTrackingHook = createTaskTrackingHook(runtime);

    await taskTrackingHook["tool.execute.after"]?.(
      {
        sessionID: "s-turing-repair",
        tool: "task",
        args: {
          subagent_type: "turing",
          description: "Review latest diff",
        },
      },
      {
        output:
          '{"task_id":"task_turing_repair","sessionID":"child-turing-repair"}\nverdict: request-changes',
      },
    );

    const repairInput: {
      sessionID: string;
      tool: string;
      args: {
        subagent_type: string;
        description: string;
        task_id?: string;
      };
    } = {
      sessionID: "s-turing-repair",
      tool: "task",
      args: {
        subagent_type: "turing",
        description: "Review latest diff",
      },
    };

    await taskTrackingHook["tool.execute.before"]?.(repairInput, {});

    expect(repairInput.args.task_id).toBe("task_turing_repair");
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

  it("omits clean Turing threads and labels open Turing review threads in injection", async () => {
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
        sessionID: "s-review-hints",
        tool: "task",
        args: {
          subagent_type: "turing",
          description: "Review latest diff",
        },
      },
      {
        output:
          '{"task_id":"task_turing_open","sessionID":"child-turing-open"}\nverdict: request-changes',
      },
    );
    await taskTrackingHook["tool.execute.after"]?.(
      {
        sessionID: "s-review-hints",
        tool: "task",
        args: {
          subagent_type: "turing",
          description: "Clean follow-up review",
        },
      },
      {
        output:
          '{"task_id":"task_turing_clean","sessionID":"child-turing-clean"}\nverdict: approve',
      },
    );

    const primaryOutput: { message: Record<string, unknown> } = {
      message: { agent: "mrrobot" },
    };
    await sessionStartHook["chat.message"]?.(
      { sessionID: "s-review-hints", agent: "mrrobot" },
      primaryOutput,
    );

    expect(String(primaryOutput.message.system ?? "")).toContain(
      "turing=task_turing_open (Review latest diff) [open-review]",
    );
    expect(String(primaryOutput.message.system ?? "")).not.toContain(
      "task_turing_clean",
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

    const primaryOutput: { message: Record<string, unknown> } = {
      message: { agent: "mrrobot" },
    };
    await sessionStartHook["chat.message"]?.(
      { sessionID: "s5", agent: "mrrobot" },
      primaryOutput,
    );

    expect(String(primaryOutput.message.system ?? "")).toContain(
      "turing=task_turing_keepdesc (Review latest diff)",
    );
  });
});

describe("prompt policy", () => {
  it("keeps reasoning private and answers in a compact mirrored style", () => {
    const coordinatorPrompt = buildCoordinatorPrompt();
    const eliotPrompt = buildEliotPrompt();

    for (const prompt of [coordinatorPrompt, eliotPrompt]) {
      expect(prompt).toContain(
        "Internal reasoning may use whichever language gives you the strongest reasoning. Do not force internal reasoning into the user's language.",
      );
      expect(prompt).toContain(
        "Do not expose private chain-of-thought. Share only the decision, result, blocker, or a short rationale when it helps the user.",
      );
      expect(prompt).toContain(
        "Before tool-using or multi-step work, start with one short sentence saying what you will do first, then act.",
      );
      expect(prompt).toContain(
        "Mirror the user's conversational shape and tone, but clean up grammar and punctuation.",
      );
      expect(prompt).toContain(
        "Do not stack every thought on a new line. Avoid inventory-style lists unless the user asks for a list or structure materially improves scan speed.",
      );
      expect(prompt).toContain(
        "When listing comparable structured items, prefer a compact markdown table over bullets.",
      );
    }
  });

  it("requires external verification for framework and library guidance", () => {
    const coordinatorPrompt = buildCoordinatorPrompt();
    const workerPrompt = buildEliotPrompt();
    const claudePrompt = buildClaudePrompt();
    const tyrellPrompt = buildTyrellPrompt();

    for (const prompt of [
      coordinatorPrompt,
      workerPrompt,
      claudePrompt,
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
    const eliotPrompt = buildEliotPrompt();
    const claudePrompt = buildClaudePrompt();
    const tyrellPrompt = buildTyrellPrompt();
    const turingPrompt = createHarnessAgents({ agents: {}, mcps: {} }).turing as {
      prompt: string;
    };

    for (const prompt of [
      coordinatorPrompt,
      eliotPrompt,
      claudePrompt,
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
    expect(eliotPrompt).toContain(
      "Verify the fix against the same failing path before you report the packet complete.",
    );
    expect(claudePrompt).toContain(
      "For stateful flows such as auth, cache, restart, logout/login, or persisted settings, verify the state transition, not only the code change.",
    );
    expect(turingPrompt.prompt).toContain(
      "If the packet is still unverified, say exactly what remains unverified instead of implying success.",
    );
  });

  it("requires concrete task packets when delegating to subagents", () => {
    const prompt = buildCoordinatorPrompt();

    expect(prompt).toContain(
      "Use OpenCode Task for Eliot, Tyrell, claude, and turing.",
    );
    expect(prompt).toContain(
      "Keep the mainline task with MrRobot unless delegation gives a clear advantage.",
    );
    expect(prompt).toContain(
      "Route claude packets by default when the work is frontend-design-heavy: pages, components, styling, layout, visual polish, or responsive UX.",
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
    const installedSkills = [
      "adapt",
      "animate",
      "building-native-ui",
      "colorize",
      "critique",
      "frontend-design",
      "harden",
      "impeccable",
      "layout",
      "optimize",
      "polish",
      "redesign-skill",
      "shape",
      "taste-skill",
      "typeset",
      "vue-vite-ui",
    ];
    const coordinatorPrompt = buildCoordinatorPrompt(undefined, undefined, installedSkills);
    const eliotPrompt = buildEliotPrompt(undefined, undefined, installedSkills);
    const claudePrompt = buildClaudePrompt(undefined, undefined, installedSkills);
    const tyrellPrompt = buildTyrellPrompt(undefined, undefined, installedSkills);

    expect(coordinatorPrompt).toContain(
      "MrRobot owns the main task by default and should handle the primary implementation path directly when the work is clear, scoped, and reversible.",
    );
    expect(coordinatorPrompt).toContain(
      "Use Eliot for delegated support packets: scoped research, repo scouting, parallel side work, or isolated implementation that should be completed cleanly inside the repo and handed back with a concise result.",
    );
    expect(coordinatorPrompt).toContain(
      "Use Claude as the default implementation lane for frontend-design-heavy packets: pages, components, styling, layout, responsive UX, and visual polish.",
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
      "Do not treat Eliot, Claude, or tyrell as the default lane for every task. Route only when delegation clearly helps.",
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
    expect(claudePrompt).toContain("Claude — frontend design subagent.");
    expect(claudePrompt).toContain(
      "Default to implementing assigned frontend design packets directly in code.",
    );
    expect(claudePrompt).toContain(
      "Greenfield frontend builds are in scope when the packet is mainly about creating the UI itself.",
    );
    expect(claudePrompt).toContain(
      "Create the minimal frontend scaffold needed for the assigned UI packet when no existing UI layer is present, using repo cues first and the safest standard stack second.",
    );
    expect(claudePrompt).toContain(
      "Do not drift into backend, API, auth, database, or state-architecture work.",
    );
    expect(claudePrompt).toContain(
      "Honor review-only or no-file-edit instructions from the assigning primary agent.",
    );
    expect(claudePrompt).toContain(
      "If MrRobot marks the packet as implementation and does not forbid file edits, make the change directly in the repo.",
    );
    expect(claudePrompt).toContain(
      "For greenfield, branding-heavy, or visual-system frontend packets, load impeccable first when it fits.",
    );
    expect(claudePrompt).toContain(
      "Use taste-skill for stack-aware premium UI work inside the repo's existing conventions.",
    );
    expect(claudePrompt).toContain(
      "Use redesign-skill when improving an existing interface in place instead of restyling from zero.",
    );
    expect(claudePrompt).toContain(
      "For routine repo-consistent frontend fixes, do not let impeccable's teach flow block small edits; use repo evidence first and pull in only the focused skill that helps.",
    );
    expect(claudePrompt).toContain(
      "For narrower frontend passes, use the matching installed skill when helpful: layout, typeset, colorize, polish, critique, adapt, animate, harden, optimize, shape.",
    );
    expect(claudePrompt).toContain(
      "If the repo is Vue/Vite, use vue-vite-ui for implementation details when it fits.",
    );
    expect(claudePrompt).toContain(
      "If the repo is Expo or Expo Router, use building-native-ui for platform patterns.",
    );
    expect(claudePrompt).toContain(
      "Use frontend-design as the fallback when the repo explicitly depends on that exact skill.",
    );
    expect(claudePrompt).toContain(
      "Do not recommend or call a frontend skill by name unless it is listed as installed below or skill_find confirms it exists in this session.",
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
    expect(coordinatorPrompt).toContain(
      "After any non-trivial code change, including MrRobot, Eliot, Claude, or Tyrell authored changes, run a Turing pass unless the change was truly trivial and local.",
    );
    expect(coordinatorPrompt).toContain(
      "If Turing requests changes, send the fix back to the original implementation lane, then reuse that same Turing thread to verify the repair. If the prior Turing review is already clean, use a fresh Turing pass for new review work.",
    );
  });

  it("encourages skill_find and the current installed skill list", () => {
    const installedSkills = ["custom-skill", "webapp-testing"];
    const coordinatorPrompt = buildCoordinatorPrompt(undefined, undefined, installedSkills);
    const eliotPrompt = buildEliotPrompt(undefined, undefined, installedSkills);
    const claudePrompt = buildClaudePrompt(undefined, undefined, installedSkills);
    const tyrellPrompt = buildTyrellPrompt(undefined, undefined, installedSkills);
    const turingPrompt = buildTuringPrompt(undefined, undefined, installedSkills);

    for (const prompt of [
      coordinatorPrompt,
      eliotPrompt,
      claudePrompt,
      tyrellPrompt,
      turingPrompt,
    ]) {
      expect(prompt).toContain("skill_find");
      expect(prompt).toContain("skill_use");
      expect(prompt).toContain("- Currently installed skills:");
      expect(prompt).toContain("  - custom-skill");
      expect(prompt).toContain("  - webapp-testing");
      expect(prompt).toContain(
        "Do not call skill_use for a skill name unless it is listed above or skill_find confirms it is installed in this session.",
      );
      expect(prompt).not.toContain("opencode-plugin-dev, image-prompting");
    }
  });

  it("gives workers concrete image MCP usage guidance when that MCP is enabled", () => {
    const installedSkills = ["image-prompting"];
    const eliotPrompt = buildEliotPrompt(undefined, undefined, installedSkills);
    const claudePrompt = buildClaudePrompt(undefined, undefined, installedSkills);
    const tyrellPrompt = buildTyrellPrompt(undefined, undefined, installedSkills);
    const turingPrompt = buildTuringPrompt(undefined, undefined, installedSkills);

    for (const prompt of [eliotPrompt, claudePrompt, tyrellPrompt, turingPrompt]) {
      expect(prompt).toContain(
        "- context7: Library and framework documentation with version-aware examples for current API usage and implementation details.",
      );
      expect(prompt).toContain(
        "- web-agent-mcp: Browser automation for navigating pages, interacting with controls, observing DOM/a11y/text/network state, screenshots, and local web app verification.",
      );
      expect(prompt).toContain("For openai-image-gen-mcp:");
      expect(prompt).toContain(
        "call the Skill tool directly with name `image-prompting` first; do not rely on skill_find for this path",
      );
      expect(prompt).toContain(
        "PNG output, high quality, auto size, and auto background are fixed by the server.",
      );
      expect(prompt).toContain("surface the returned `source_prompt_preview` in your reply");
      expect(prompt).toContain("include `source_prompt` when they ask for the exact prompt text");
    }
  });

  it("gives primary prompts the same image MCP bridge guidance", () => {
    const installedSkills = ["image-prompting"];
    const coordinatorPrompt = buildCoordinatorPrompt(undefined, undefined, installedSkills);

    for (const prompt of [coordinatorPrompt]) {
      expect(prompt).toContain("For openai-image-gen-mcp, call the Skill tool directly with `image-prompting`");
      expect(prompt).toContain("put the final image brief in `prompt_json`");
      expect(prompt).toContain("forwards `source_prompt` verbatim");
      expect(prompt).toContain("show the returned `source_prompt_preview` in the user-facing reply");
      expect(prompt).toContain("use `source_prompt` when the user asks for the exact prompt text");
    }
  });

  it("does not blindly call image-prompting when that skill is absent", () => {
    const coordinatorPrompt = buildCoordinatorPrompt(undefined, undefined, ["custom-skill"]);
    const eliotPrompt = buildEliotPrompt(undefined, undefined, ["custom-skill"]);
    const claudePrompt = buildClaudePrompt(undefined, undefined, ["custom-skill"]);

    for (const prompt of [coordinatorPrompt, eliotPrompt, claudePrompt]) {
      expect(prompt).toContain(
        "load `image-prompting` first only if it is installed or skill_find confirms it exists",
      );
      expect(prompt).not.toContain(
        "call the Skill tool directly with name `image-prompting` first; do not rely on skill_find for this path",
      );
      expect(prompt).not.toContain("Use taste-skill for stack-aware premium UI work");
      expect(prompt).not.toContain("load impeccable first");
      expect(prompt).not.toContain("Use redesign-skill when improving an existing interface");
    }
  });

  it("prefers continuing the same subagent thread before spawning fresh", () => {
    const coordinatorPrompt = buildCoordinatorPrompt();
    const eliotPrompt = buildEliotPrompt();
    const claudePrompt = buildClaudePrompt();
    const turingPrompt = createHarnessAgents({ agents: {}, mcps: {} }).turing as {
      prompt: string;
    };

    expect(coordinatorPrompt).toContain(
      "Reuse an existing task_id by default when the same lane is continuing the same packet, refinement pass, or follow-up; lanes may auto-reuse an active exact workstream match when safe, and Turing should only do that for open repair verification threads.",
    );
    expect(coordinatorPrompt).toContain(
      "Spawn a fresh subagent only when the scope changes materially, the prior thread is complete, or you intentionally want a clean context reset.",
    );
    expect(eliotPrompt).toContain(
      "When you call Task for a continuing lane and workstream, reuse the existing task_id by default; lanes may auto-reuse an active exact workstream match when safe, and Turing should only do that for open repair verification threads.",
    );
    expect(claudePrompt).toContain(
      "When you call Task for a continuing lane and workstream, reuse the existing task_id by default; lanes may auto-reuse an active exact workstream match when safe, and Turing should only do that for open repair verification threads.",
    );
    expect(turingPrompt.prompt).toContain(
      "When you call Task for a continuing lane and workstream, reuse the existing task_id by default; lanes may auto-reuse an active exact workstream match when safe, and Turing should only do that for open repair verification threads.",
    );
  });

  it("keeps character identity user-facing instead of introducing OpenCode first", () => {
    const coordinatorPrompt = buildCoordinatorPrompt();
    const eliotPrompt = buildEliotPrompt();
    const claudePrompt = buildClaudePrompt();
    const tyrellPrompt = buildTyrellPrompt();
    const turingPrompt = createHarnessAgents({ agents: {}, mcps: {} }).turing as {
      prompt: string;
    };

    expect(coordinatorPrompt).toContain('Your user-facing identity is MrRobot.');
    expect(eliotPrompt).toContain('Your user-facing identity is Eliot.');
    expect(claudePrompt).toContain('Your user-facing identity is Claude.');
    expect(tyrellPrompt).toContain('Your user-facing identity is Tyrell.');
    expect(turingPrompt.prompt).toContain(
      'Your user-facing identity is Turing.',
    );
  });

});
