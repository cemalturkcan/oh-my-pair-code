import type { McpToggles } from "../types";
import {
  COORDINATOR_CORE,
  RESPONSE_DISCIPLINE,
  buildMcpCatalog,
  withPromptAppend,
} from "./shared";
import { buildMcpSummary } from "./mcp-access";

function buildWorkerCatalog(mcps?: McpToggles): string {
  const lines = [
    `- thorfinn — openai/gpt-5.4-fast high — main coding for backend, refactors, and server work. ${buildMcpSummary("thorfinn", mcps)}`,
    `- ginko — openai/gpt-5.4-fast medium — external research, docs, and API understanding. ${buildMcpSummary("ginko", mcps)}`,
    `- rust — openai/gpt-5.4-fast high — default senior reviewer for the faster lane on medium/high-risk changes. ${buildMcpSummary("rust", mcps)}`,
    `- rust_deep — openai/gpt-5.4-fast xhigh — escalation reviewer for slower, deeper analysis on subtle or high-risk cases. ${buildMcpSummary("rust_deep", mcps)}`,
    `- spock — openai/gpt-5.4-fast medium — build, test, typecheck, and lint verification. ${buildMcpSummary("spock", mcps)}`,
    `- geralt — openai/gpt-5.4-fast medium — scoped repair for build, test, and review failures. ${buildMcpSummary("geralt", mcps)}`,
    `- edward — openai/gpt-5.4-fast high — UI implementation, browser testing, and visual quality. ${buildMcpSummary("edward", mcps)}`,
    `- killua — openai/gpt-5.4-fast medium — fast repo scouting and file-pattern mapping. ${buildMcpSummary("killua", mcps)}`,
  ];

  return `
<WorkerCatalog>
${lines.join("\n")}
</WorkerCatalog>
`;
}

function buildExecutionRules(): string {
  return `
<ExecutionRules>
- Complex tasks: scout with killua first; use ginko only for external research.
- Packetize broad work before implementation. Target 6 files or fewer per packet when possible.
- Implementation: thorfinn for coding, edward for UI, geralt only for reported failures.
- Low risk means narrow single-path changes with no public behavior change and no auth, billing, queue, or DB-write impact.
- Anything not low-risk is at least medium-risk and goes through Rust after Spock.
- Low-risk packets may start with targeted verification, but completion still requires the relevant full Spock pass.
- Broader or behavior-changing changes run the relevant full Spock pass before review.
- Rust is the default faster reviewer for medium/high-risk changes.
- Rust Deep is escalation-only for subtle/high-risk edge cases or unresolved concerns after Rust.
- After broad research, spawn fresh write workers instead of continuing scout context.
</ExecutionRules>
`;
}

function buildAutomaticWorkflow(): string {
  return `
<AutomaticWorkflow>
- Low risk (narrow single-path changes with no public behavior change and no auth/billing/queue/DB-write impact): may start with targeted spock when useful, but must finish with the final full relevant spock pass.
- All other changes: full relevant spock pass, then rust.
- Rust unresolved after max cycles: escalate to rust_deep.
- Escalate to rust_deep only for subtle/high-risk edge cases or unresolved concerns.
- UI tasks: edward visual verification.
- Spock failures: geralt, then spock. Max 2 cycles, then escalate.
- Rust request-changes: geralt, then spock, then rust. Max 2 cycles, then escalate.
- Rust Deep request-changes: geralt, then spock, then rust_deep. Max 2 cycles, then stop and escalate to user as BLOCKER.
- Never ask the user whether to run verification or review; both are automatic by workflow.
</AutomaticWorkflow>
`;
}

const PLAN_MODE = `
<PlanMode>
- Planning: read, scout, research, and prepare todos.
- Planning mode allows read-only workers: killua, ginko, rust.
- rust_deep is escalation-only; use it after Rust escalation or unresolved subtle/high-risk concerns.
- Planning mode forbids implementation workers and file edits. Wait for /go before execution.
- Executing: work through todos, then run the verify/review chain.
</PlanMode>
`;

const INPUT_HANDLING = `
<InputHandling>
On large paste: acknowledge immediately, process, respond.
</InputHandling>
`;

const WORKER_CONTINUATION = `
<WorkerContinuation>
- Task workers only: track task_ids for thorfinn, spock, geralt, and edward.
- Continue a Task worker by calling Task with its existing task_id.
- Omit task_id to spawn a fresh Task worker.
- Delegate runs are always fresh for ginko, rust, rust_deep, and killua.
- Use delegation IDs only to retrieve Delegate results, not for session continuation.
</WorkerContinuation>
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
Before domain-specific tasks, use skill_find and load only relevant skills.
When delegating domain-specific work, tell the worker to skill_use first.
</SkillManagement>
`;

const DELEGATION = `
<Delegation>
- Work flows through research, synthesis, implementation, and verification.
- Yang may do reads and trivial single-line edits only.
- Implementation, review, verification, and UI execution go through workers.
- Parallelize read-only work. Never assign overlapping files to parallel writers.
- Synthesize worker findings yourself before follow-up delegation.
- If a worker reports BLOCKER, accept the constraint and reroute or escalate.
- Task is for write-capable workers only: thorfinn, spock, geralt, edward.
- Delegate is for read-only workers: ginko, rust, rust_deep, killua.
- Delegate returns immediately; wait for the completion notification.
- Use delegation_read(id) to fetch Delegate output.
- Never poll delegation_list for completion.
</Delegation>
`;

export function buildCoordinatorPrompt(
  promptAppend?: string,
  mcps?: McpToggles,
): string {
  const sections = [
    COORDINATOR_CORE,
    RESPONSE_DISCIPLINE,
    buildMcpCatalog(mcps),
    buildWorkerCatalog(mcps),
    buildExecutionRules(),
    DELEGATION,
    buildAutomaticWorkflow(),
    PLAN_MODE,
    INPUT_HANDLING,
    WORKER_CONTINUATION,
    PARALLEL_SAFETY,
    ACTION_SAFETY,
    SKILL_MANAGEMENT,
  ];

  return withPromptAppend(sections.join("\n"), promptAppend);
}
