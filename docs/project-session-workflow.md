# Project, session, and direct-ledger workflow

OpenCode slash commands installed by `opencode-pair` are Mission Control templates. They guide the primary `mission-control` agent to use orchestrator tools, direct repo work, or worker delegation while preserving Mission Control as the owner of decomposition, blocker aggregation, and final gate checks.

## Commands

| Command | Intended usage | Primary tools |
| --- | --- | --- |
| `/project-status` | Resolve the current project/session and summarize active or recent sessions, tasks, blockers, mission state, and next actions. | `orchestrator_project_resolve`, `orchestrator_session_attach`, `orchestrator_session_current`, `orchestrator_project_status` |
| `/task-current` | Show the durable session and linked task context for the current OpenCode session. | `orchestrator_session_current`, `orchestrator_get_current_task`, `orchestrator_project_resolve` |
| `/project-tasks <filter>` | List or search backlog and mission tasks for the current project, usually before resuming work. | `orchestrator_project_resolve`, `orchestrator_project_tasks` |
| `/resume-task <task_id>` | Attach the current OpenCode session to a selected durable task and verify the task context. | `orchestrator_project_resolve`, `orchestrator_project_tasks`, `orchestrator_session_attach`, `orchestrator_session_current`, `orchestrator_get_current_task` |
| `/context-search <query>` | Search durable project/task context and compact it for handoff when needed. | `orchestrator_project_resolve`, `orchestrator_session_current`, `orchestrator_get_current_task`, `orchestrator_context_search`, `orchestrator_context_compact` |

Existing mission commands remain available:

- `/orchestrate <request>` creates or resumes a Mission Control mission and delegates worker packets.
- `/mission-status` summarizes active mission status and gate state.
- `/mission-blockers` reports unresolved blockers or gate failures that need user action.

## Resume flow

1. Start with `/project-status` to confirm the repository project and active ledger state.
2. Use `/project-tasks <keyword/status>` to find the backlog or mission task you want to resume.
3. Use `/resume-task <task_id>` to attach the current OpenCode session to that task.
4. Use `/task-current` to verify the durable session-to-task link.
5. Use `/context-search <topic>` to recover compact decisions, evidence, and handoff context before continuing.

Workers should still use their direct-ledger tools from their assigned task packet. Mission Control remains responsible for creating/resuming missions, choosing workers, coordinating blockers, and running `orchestrator_gate_check` before claiming final success.

## Compatibility note

The default ledger is now global user state, not project state. Existing `.opencode/state/orchestrator.sqlite` files are copied to the global default only when that target does not already exist; the source file is left in place. Track `.opencode/orch.txt` for stable project identity and keep `.opencode/state/` ignored.
