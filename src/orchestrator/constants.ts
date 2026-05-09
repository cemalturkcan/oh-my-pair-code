export const PRIMARY_AGENT = "mission-control" as const;

export const WORKER_AGENTS = [
  "implementation-engineer",
  "frontend-engineer",
  "repo-scout",
  "research-analyst",
  "creative-strategist",
  "verification-engineer",
] as const;

export const AGENT_ROSTER = [PRIMARY_AGENT, ...WORKER_AGENTS] as const;

export type PrimaryAgent = typeof PRIMARY_AGENT;
export type WorkerAgent = (typeof WORKER_AGENTS)[number];
export type HarnessAgent = (typeof AGENT_ROSTER)[number];

export const WORKER_AGENT_SET = new Set<string>(WORKER_AGENTS);

export const WRITER_AGENTS = new Set<string>([
  "implementation-engineer",
  "frontend-engineer",
]);

export const READ_ONLY_AGENTS = new Set<string>([
  "repo-scout",
  "research-analyst",
  "creative-strategist",
  "verification-engineer",
]);

export const ORCHESTRATION_TOOL_PREFIX = "orchestrator_";

export const ORCHESTRATION_TOOL_NAMES = [
  "orchestrator_project_resolve",
  "orchestrator_project_sensitivity_profile",
  "orchestrator_project_status",
  "orchestrator_flight_deck_report",
  "orchestrator_session_attach",
  "orchestrator_session_current",
  "orchestrator_get_current_task",
  "orchestrator_project_tasks",
  "orchestrator_context_search",
  "orchestrator_research_route",
  "orchestrator_tool_preflight",
  "orchestrator_context_compact",
  "orchestrator_mission_create",
  "orchestrator_mission_status",
  "orchestrator_task_create",
  "orchestrator_task_update",
  "orchestrator_task_reopen",
  "orchestrator_artifact_publish",
  "orchestrator_artifact_query",
  "orchestrator_context_publish",
  "orchestrator_context_query",
  "orchestrator_decision_record",
  "orchestrator_blocker_create",
  "orchestrator_blocker_resolve",
  "orchestrator_verification_record",
  "orchestrator_gate_check",
] as const;

export type OrchestrationToolName = (typeof ORCHESTRATION_TOOL_NAMES)[number];
