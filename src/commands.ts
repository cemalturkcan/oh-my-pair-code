import type { HarnessConfig } from "./types";

export function createHarnessCommands(config: HarnessConfig): Record<string, Record<string, unknown>> {
  if (config.commands?.enabled === false) {
    return {};
  }

  return {
    "pair-plan": {
      template: "{{args}}",
      description: "Run the request with the planning-first Markdown-only pair agent.",
      agent: "pair-plan",
    },
    pair: {
      template: "{{args}}",
      description: "Run the request with the pair agent.",
      agent: "pair",
    },
    autonomous: {
      template: "{{args}}",
      description: "Run the request with the autonomous agent.",
      agent: "autonomous",
    },
    learn: {
      template: "Review the latest session summaries and learning observations. Extract durable user preferences, repo conventions, workflow rules, and repeated failure patterns. Return only the high-signal learnings with brief confidence notes. {{args}}",
      description: "Extract reusable learnings from recent session artifacts.",
      agent: "learning-extractor",
      subtask: true,
    },
    "memory-status": {
      template: "Inspect saved session memory and project memory artifacts for this repository. Summarize what context is currently available, what is likely still useful, and any obvious gaps. {{args}}",
      description: "Summarize the current saved memory for this repo.",
      agent: "memory-curator",
      subtask: true,
    },
    verify: {
      template: "Run a focused verification pass for the current work and report the first meaningful failures or confirmation of success. {{args}}",
      description: "Run a focused verifier pass.",
      agent: "verifier",
      subtask: true,
    },
    "worktree-start": {
      template: "Design a safe git worktree plan for this task. Return the worktree layout, branch naming, base branch assumptions to verify, exact shell commands to create and clean up the worktree, and the conditions that justify using a separate worktree instead of staying in-place. Keep it bounded and repo-consistent. {{args}}",
      description: "Plan a safe worktree-based execution flow.",
      agent: "loop-orchestrator",
      subtask: true,
    },
    "parallel-plan": {
      template: "Break this task into the smallest useful parallel slices. Say what should stay in the main agent, what can go to subagents, what should run in PTY/background processes, the merge order, and the verification checkpoints. Prefer sparse subagent use and bounded slices. {{args}}",
      description: "Create a bounded parallelization and cascade plan.",
      agent: "loop-orchestrator",
      subtask: true,
    },
    "loop-start": {
      template: "Produce a phased execution loop for this task. Include entry conditions, iteration steps, stop conditions, verification gates, when to checkpoint, when to compact, and when PTY/background execution is better than more subagents. If worktrees help, include that too. {{args}}",
      description: "Create a phased execution loop runbook.",
      agent: "loop-orchestrator",
      subtask: true,
    },
    checkpoint: {
      template: "Summarize the current execution state as a compact checkpoint: what is done, what is next, what verification remains, and whether a loop/worktree/parallelization adjustment is warranted. {{args}}",
      description: "Create a compact execution checkpoint.",
      agent: "loop-orchestrator",
      subtask: true,
    },
  };
}
