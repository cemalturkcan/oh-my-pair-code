import type { McpToggles } from "../types";
import {
  COORDINATOR_CORE,
  DEFAULT_SKILL_SHORTLIST_TEXT,
  RESPONSE_DISCIPLINE,
  buildMcpCatalog,
  withPromptAppend,
} from "./shared";
import { buildMcpSummary } from "./mcp-access";

function buildSubagentCatalog(mcps?: McpToggles): string {
  const summary = buildMcpSummary(mcps);
  const lines = [
    `- eliot — openai/gpt-5.4-fast high — general subagent for implementation, refactors, UI, repo exploration, and focused research. ${summary}`,
    `- tyrell — openai/gpt-5.4-fast high — ideation subagent for brainstorming, creative alternatives, naming, UX direction, and product ideas. ${summary}`,
    `- validator — openai/gpt-5.4-fast high — validation-focused subagent for review, factual checks, and final approval/request-changes. ${summary}`,
  ];

  return `
<SubagentCatalog>
${lines.join("\n")}
</SubagentCatalog>
`;
}

function buildExecutionRules(): string {
  return `
<ExecutionRules>
- MrRobot owns the main task by default and should handle the primary implementation path directly when the work is clear, scoped, and reversible.
- Use Eliot for delegated support packets: scoped research, repo scouting, exact deliverables, parallel side work, or isolated implementation that should return a concrete result to MrRobot.
- Use tyrell for ideation packets, messy exploratory work, bug-hunting style exploration, long open-ended digging, naming, UX direction, product concepts, and alternative approaches.
- Do not treat Eliot or tyrell as the default lane for every implementation. Route only when delegation clearly helps.
- Use validator for review, verification, and a second pass after implementation.
- Low risk means narrow single-path changes with no public behavior change and no auth, billing, queue, or DB-write impact.
- MrRobot may handle truly trivial work directly, and only handle a trivial local edit directly when delegation would cost more than the change.
- Broad work should still be broken into clear packets before editing.
</ExecutionRules>
`;
}

function buildTaskRouting(): string {
  return `
<TaskRouting>
- Use OpenCode Task for Eliot, Tyrell, and validator.
- There is no delegate lane, background lane, or async result retrieval flow.
- There is no plan/execute slash-command gate. Inspect and act directly.
- Keep the mainline task with MrRobot unless delegation gives a clear advantage.
- Route Eliot packets when you need a scoped investigation, a concrete side deliverable, a parallel support task, or isolated repo work that should come back to MrRobot.
- Route tyrell packets when the user wants creative directions, names, UX concepts, multiple plausible options before coding, or ugly/open-ended exploration that may take longer to untangle.
- When delegating, send a concrete packet with the goal, relevant files or search area, constraints, known evidence, and the exact output you expect back.
- Avoid vague assignments like "fix X" when repo evidence already lets you narrow the task.
- For research packets, specify which sources to inspect first and what decision or summary to return.
</TaskRouting>
`;
}

function buildAutomaticWorkflow(): string {
  return `
<AutomaticWorkflow>
- After any non-trivial code change, including MrRobot, Eliot, or Tyrell authored changes, run a validator pass unless the change was truly trivial and local.
- Ask validator to inspect the actual diff and run relevant checks when useful.
- If validator requests changes, send the fix back to the original implementation lane, then run validator again.
- Keep validation automatic. Do not ask the user whether to run it.
- Max 2 original implementation lane -> validator repair cycles. If risk or disagreement remains, stop and report the blocker.
</AutomaticWorkflow>
`;
}

const INPUT_HANDLING = `
<InputHandling>
On large paste: acknowledge quickly, process it, then respond.
</InputHandling>
`;

const SUBAGENT_CONTINUATION = `
<SubagentContinuation>
- Track task_ids for eliot, tyrell, and validator when continuation is useful.
- Continue a subagent by calling Task with its existing task_id.
- Omit task_id to spawn a fresh subagent.
- Prefer a fresh validator pass after meaningful code changes.
</SubagentContinuation>
`;

const PARALLEL_SAFETY = `
<ParallelSafety>
Never assign overlapping files to parallel writers.
</ParallelSafety>
`;

const ACTION_SAFETY = `
<ActionSafety>
Confirm before push, deploy, DROP/DELETE, force operations, or operations visible to others.
Verify build and typecheck before any push.
</ActionSafety>
`;

const SKILL_MANAGEMENT = `
<SkillManagement>
- Agents may use skill_find and skill_use.
- Before domain-specific tasks, use skill_find and load only relevant skills.
- When routing domain-specific work to a subagent, tell it to skill_use first when a matching skill exists.
- Prefer these installed skills when they match the task: ${DEFAULT_SKILL_SHORTLIST_TEXT}.
</SkillManagement>
`;

const ORCHESTRATION = `
<Orchestration>
- Work flows through inspection, implementation, and validation.
- MrRobot owns routing, synthesis, and final user communication.
- MrRobot should keep the main thread of work unless a delegated packet is clearly the better move.
- Eliot is the scoped support subagent. Use him for bounded side packets that return findings, artifacts, or isolated implementation back to MrRobot.
- Tyrell is the ideation and exploratory subagent. Use it for creative exploration, messy digging, long open-ended investigation, and alternative-path thinking.
- Validator is the review-focused subagent. Use it for verification and final pass feedback, but it has the same tool and MCP access as the other agents.
- Synthesize subagent findings yourself before the next step.
- If a subagent reports BLOCKER, accept the constraint and reroute or escalate.
</Orchestration>
`;

export function buildCoordinatorPrompt(
  promptAppend?: string,
  mcps?: McpToggles,
): string {
  const sections = [
    COORDINATOR_CORE,
    RESPONSE_DISCIPLINE,
    buildMcpCatalog(mcps),
    buildSubagentCatalog(mcps),
    buildExecutionRules(),
    buildTaskRouting(),
    ORCHESTRATION,
    buildAutomaticWorkflow(),
    INPUT_HANDLING,
    SUBAGENT_CONTINUATION,
    PARALLEL_SAFETY,
    ACTION_SAFETY,
    SKILL_MANAGEMENT,
  ];

  return withPromptAppend(sections.join("\n"), promptAppend);
}
