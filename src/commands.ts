import type { HarnessConfig } from "./types";

export function createHarnessCommands(
  config: HarnessConfig,
): Record<string, Record<string, unknown>> {
  if (config.commands?.enabled === false) {
    return {};
  }

  return {
    orchestrate: {
      description: "Create or resume a Mission Control mission for the request.",
      agent: "mission-control",
      template:
        "Use the orchestration ledger for this request: $ARGUMENTS\n\nMission Control is a task manager/orchestrator only, not an executor. If no active mission fits, call orchestrator_mission_create and decompose durable multi-step or repo-impacting work into ledger tasks. For small web/news/library lookups, do not create ledger tasks: use orchestrator_tool_preflight/orchestrator_research_route when route choice is unclear, then either handle directly or delegate an ephemeral research-analyst packet with source URL/date/freshness/version/confidence requirements and no raw tool traces. In planning mode stay read-only and delegation-focused. After explicit execution approval, delegate writer tasks when they are in scope; do not inspect large files, edit, run build/test/lint commands, or perform git workflow steps directly. Git branch/commit/push/revert/reset requires explicit operation-level confirmation with branch/remote/strategy and should be delegated as a scoped implementation task. Project-level guard-preflight, env-write, external-side-effect, and worker-spawn blocks are disabled except for this Mission Control delegation-only boundary. Run orchestrator_gate_check before final success.",
    },
    "mission-status": {
      description: "Show the current ledger-backed mission status and gate state.",
      agent: "mission-control",
      template:
        "Call orchestrator_mission_status for the active mission. Summarize task status, blockers, verification state, and next required actions compactly.",
    },
    "mission-flight-deck": {
      description:
        "Show a read-only mission/project flight deck with task lanes and acceptance coverage.",
      agent: "mission-control",
      template:
        "Flight deck request: $ARGUMENTS\n\nCall orchestrator_flight_deck_report for the active mission, or pass a project_id/mission_id from the user's arguments when provided. Report compact lanes for ready, blocked, needs verification, in progress, done, the acceptance coverage heatmap (unmet/claimed/evidenced/verified), gate state when present, and next_safest_action. This command is read-only: do not mutate task state, delegate workers, or claim final success unless a separate orchestrator_gate_check allows it.",
    },
    "mission-blockers": {
      description: "Show unresolved mission blockers grouped for user action.",
      agent: "mission-control",
      template:
        "Call orchestrator_gate_check for the active mission and report only unresolved blockers or gate failures that need user action. Do not claim final completion unless can_final_success is true.",
    },
    "orchestrator-sync": {
      description:
        "Show the side-effect-free ledger sync lifecycle status for the configured private sync repo.",
      agent: "mission-control",
      template:
        "Ledger sync request: $ARGUMENTS\n\nCall orchestrator_sync_status with phase=manual unless the user asks for session_start, checkpoint, session_end, or crash_recovery. Explain that configured sync uses the automatic lifecycle: OpenCode/session start pulls best-effort and clean session exit checkpoints/copies, commits only when changed, and pushes best-effort. Report configured status, lifecycle policy, optional recovery/debug command templates, warnings, setup next actions, and that .opencode/orch.txt is the only git-tracked project marker while raw SQLite lives in the global user store unless explicitly overridden. For checkpoint phase, say this status command does not mutate git or the DB; clean session exit handles the push. For local/remote ledger row snapshots supplied by the user or another tool, call orchestrator_sync_reconcile_plan to produce a side-effect-free merge/conflict plan. For real SQLite snapshot files, preserve local/remote copies first, then call orchestrator_sync_reconcile_files with local_db_path and remote_db_path; keep dry_run=true unless the user provides an explicit distinct output_db_path for merged.sqlite. Report suggested names local.<timestamp>.sqlite, remote.<timestamp>.sqlite, merged.<timestamp>.sqlite, and conflicts.<timestamp>.json; tell the user to inspect conflicts/warnings/stats before choosing keep-local, keep-remote, restore backup, or create merged output. This command is side-effect-free by default: do not run git pull/push/commit/reset, replace the active DB, or mutate the active ledger unless the user separately gives explicit approval and the operation is safely scoped.",
    },
    "project-status": {
      description:
        "Resolve the current project and show active sessions, tasks, and gate context.",
      agent: "mission-control",
      template:
        "Resolve the current project with orchestrator_project_resolve, attach/current the OpenCode session with orchestrator_session_attach or orchestrator_session_current, then call orchestrator_project_status. Summarize active/recent sessions, active mission/gate state, blockers, and next safe Mission Control actions. Preserve Mission Control as the orchestrator and gate owner; do not delegate workers or claim final success from this status-only command unless orchestrator_gate_check allows it.",
    },
    "task-current": {
      description:
        "Show the current durable OpenCode session and linked task context.",
      agent: "mission-control",
      template:
        "Call orchestrator_session_current and orchestrator_get_current_task for this OpenCode session. If no current task is linked, use orchestrator_project_resolve and explain how to attach/resume through /resume-task. Summarize task id, assignment, status, mission/project, file scope, acceptance evidence, blockers, and high-signal context. Do not bypass Mission Control ownership or mutate task state unless the user explicitly asks.",
    },
    "project-tasks": {
      description:
        "List or search durable project backlog and mission tasks for resume planning.",
      agent: "mission-control",
      template:
        "Use orchestrator_project_resolve, then orchestrator_project_tasks with any user-provided filters from $ARGUMENTS. Show matching backlog and mission tasks with task_id, status, assigned agent, active session if known, blockers, and recommended resume target. Keep this read-only unless the user explicitly asks Mission Control to create or change tasks.",
    },
    "resume-task": {
      description:
        "Attach or resume a durable task by task_id or current project/session context.",
      agent: "mission-control",
      template:
        "Resume request: $ARGUMENTS\n\nResolve the project with orchestrator_project_resolve, inspect candidates with orchestrator_project_tasks when task_id is omitted, then use orchestrator_session_attach to attach this OpenCode session to the selected project/task/mission. Call orchestrator_session_current and orchestrator_get_current_task to verify the attach. If work continues, Mission Control owns decomposition, worker delegation, blocker aggregation, and orchestrator_gate_check; project-level guard/preflight and approval-first writer blocks are disabled, but Mission Control remains delegation-only for repo inspection, edits, commands, tests, and git workflow steps.",
    },
    "context-search": {
      description:
        "Search and compact durable ledger context for the current project or task.",
      agent: "mission-control",
      template:
        "Context request: $ARGUMENTS\n\nResolve the project/session with orchestrator_project_resolve and orchestrator_session_current, inspect the linked task with orchestrator_get_current_task when available, then call orchestrator_context_search using the user's query. Use orchestrator_context_compact when the user asks for a compact handoff or when results are too large. Return curated high-signal context only; do not rely on raw worker transcripts as the default handoff.",
    },
  };
}
