# Orchestrator Ledger Plan

## Goal

Build a long-running OpenCode orchestration layer where a top-level agent owns the mission, delegates scoped work to specialist agents, preserves durable state outside the model context, verifies every acceptance criterion, and only gives a final answer when the full goal is complete or all remaining blockers require user input.

## Single-round master implementation task

Use the following as the one-shot implementation task for the full repo change. This task is intentionally large and complete; it is meant to be executed as one coordinated delivery, not split across separate PRs.

```text
Implement the full Mission Control orchestration upgrade in one delivery across this repository.

Primary outcome
- Replace the current character-driven harness with a professional orchestration system centered on Mission Control as the top-level orchestrator.
- Mission Control may directly read code, write code, patch files, and run implementation shell commands when in scope.
- Mission Control must own mission decomposition, task graph state, context packaging, worker delegation, blocker aggregation, acceptance gating, and final response synthesis.
- The system must persist durable orchestration state outside the model context through a ledger.
- The system must only report final completion when all acceptance criteria are verified or the only remaining items are explicit user-approval blockers.

Agent roster
- mission-control — primary orchestrator
- implementation-engineer — general implementation worker
- frontend-engineer — frontend/UI worker
- repo-scout — read-only repository exploration worker
- research-analyst — external/web/docs/library research worker
- verification-engineer — acceptance/verification gate worker

Required architectural changes

1. Agent and prompt model
- Rename the current agent system to the roster above everywhere relevant in code, prompts, docs, examples, and tests.
- Set `mission-control` as the default primary agent.
- Remove prompt expectations that the primary agent directly implements code.
- Keep worker roles narrow and explicit.
- Workers may spawn other workers when delegation helps complete their assigned packet.

2. Permission model
- Add real agent-level permissions instead of relying on prompt-only behavior.
- Agent permission maps must allow normal harness tool access; role prompts carry read-only/delegation semantics instead of hard permission denials.
- `repo-scout` must be prompted as read-only.
- `research-analyst` must focus on web/docs/research tooling and avoid repo edits unless explicitly scoped.
- `implementation-engineer` and `frontend-engineer` may edit files inside assigned scope.
- `verification-engineer` must be read/verification-oriented and avoid edits unless explicitly scoped.
- Runtime worker-spawn blocks are disabled.

3. Durable ledger
- Add a durable orchestration ledger as the system source of truth.
- The ledger must persist missions, tasks, task dependencies, acceptance criteria, artifacts, context bundles, decisions, blockers, legacy file-lock records, and verification results.
- The ledger must survive session continuation and compaction.
- The ledger path must be configurable and defaults to user-level state such as `$XDG_STATE_HOME/opencode-pair/orchestrator.sqlite` or `~/.local/state/opencode-pair/orchestrator.sqlite` on Linux.
- Do not rely on runtime-only maps as the source of truth for mission state.

4. Orchestration tools
- Add custom orchestration tools through the plugin layer for mission creation, mission status snapshot, task creation, task update, artifact publishing, context bundle publishing/querying, blocker creation, legacy file-lock acquire/release compatibility, gate checking, and task reopening.
- Tool schemas must be strict, descriptive, and deterministic.
- Tool output must be compact and structured.

5. Task graph model
- Replace flat progress assumptions with a dependency-aware task graph.
- Each task must have id, title, type, assigned agent, status, priority, dependencies, acceptance criteria, evidence requirements, scope, and optional file scope.
- Support statuses such as pending, in_progress, blocked, needs_verification, reopened, done, and cancelled.
- A task must not become done without either evidence-backed verification or an explicit documented low-risk exception.

6. Structured worker output
- All workers must return structured reports.
- Worker reports must include: task_id, status, summary, files_changed when relevant, criterion-by-criterion results, evidence, verification mode, commands/actions run, why_not_real when applicable, artifacts, context_for_next_agent, recommended_next_tasks, blockers, remaining_gaps, and confidence.
- `verification-engineer` must use a stricter verifier output with verdict, gate_status, checked_criteria, issues, checks_run, unverified_claims, and tasks_to_reopen.

7. Context sharing model
- Do not share raw child-session transcripts by default.
- Workers must publish high-signal context bundles to the ledger.
- Mission Control must inject only relevant mission/task/artifact/context-bundle data into downstream worker prompts.
- The system must support precise context handoff without bloating worker context windows.

8. Real execution and verification policy
- Prefer real execution over mocks whenever the action is safe, local, sandboxed, read-only, reversible, or explicitly test-scoped.
- Safe local tests, builds, typechecks, browser checks, DB read-backs, read-only local/sandbox/test HTTP requests, and similar verification must run without unnecessary user approval.
- External actions should follow task scope and evidence requirements.
- Blockers must be accumulated while the system continues all other safe independent work.
- Final or checkpoint user responses must group remaining blocker questions together.

9. Developer credential mode
- If the user explicitly provides test or sandbox credentials for the task, the system must treat them as task-scoped developer inputs.
- It may write them into explicitly relevant local ignored env files like `.env`, `.env.local`, or test fixture env files when needed for local execution.
- It must not reflexively refuse with generic secret-safety language in this local developer flow.
- It must not commit, push, or expose those credentials in final replies, logs, artifacts, or screenshots unless the user explicitly asks for exact file contents.
- Final reporting should mask values by default.

10. Acceptance gate
- Add a gate check that Mission Control must obey before giving a final response.
- Final completion is forbidden while there are open tasks, unmet acceptance criteria, unverified non-trivial changes, unresolved critical verification issues, missing evidence, or safe real checks that were skipped without reason.
- If a worker claims completion without enough evidence, the task must be reopened.

11. File-lock safety
- Keep file-lock rows as compatibility records only.
- Do not enforce single-writer behavior through project-level guards.
- Allow parallel research/read-only work when safe.

12. Session injection and compaction
- Update session-start injection so Mission Control receives a compact mission snapshot from the ledger each turn.
- Workers must receive a compact task-scoped packet from the ledger.
- Add a compaction hook that preserves mission, open tasks, blockers, decisions, locks, completed evidence refs, and next required actions.

13. Commands and optional runner
- Add command support for orchestration control such as `/orchestrate`, `/mission-status`, and `/mission-blockers` if they fit the existing command model.
- If a lightweight autonomous runner is needed, implement it through the existing repo structure and SDK-friendly patterns so the system can keep progressing until completion or blocker stop conditions are reached.

14. Tests and docs
- Update tests for renamed agents, permissions, task routing, task continuation, prompt rules, ledger behavior, gate behavior, compaction context, blocker aggregation, and credential handling.
- Fix example config drift so examples only mention supported config keys and hooks.
- Update README, agent matrix, rendered agent docs, and any relevant examples to match the new architecture.

Non-negotiable behavior constraints
- Mission Control may directly implement code.
- Workers may recursively spawn other workers.
- No mock-by-default completion claims.
- No final success without verifier-backed evidence for non-trivial work.
- No repeated piecemeal user interruptions for every blocker when safe work still remains.

Definition of done
- The repository builds and typechecks.
- Relevant tests pass.
- The new agent roster is fully wired.
- The ledger-backed orchestration flow exists and is used as the durable mission state.
- Mission Control can decompose work, delegate scoped tasks, receive structured worker reports, reopen incomplete tasks, aggregate blockers, survive compaction, and refuse final completion until orchestrator gate rules pass.
- Docs and examples match the implementation.
```

## Chosen design decisions

These are fixed choices from the discussion. The implementation must follow them unless the repo makes one impossible, in which case the blocker must be reported explicitly.

### Final agent set

The implementation must use exactly this first-release roster:

| Agent key | Display name | Type | Role |
| --- | --- | --- | --- |
| `mission-control` | Mission Control | primary | Top-level orchestrator. Owns mission decomposition, ledger state, task graph, delegation, blocker batching, acceptance gating, and final synthesis. Never directly implements code. |
| `implementation-engineer` | Implementation Engineer | worker | General implementation worker for backend, tooling, refactors, bug fixes, and scoped repo work. |
| `frontend-engineer` | Frontend Engineer | worker | Frontend/UI worker for pages, components, layout, styling, responsive behavior, and polish. |
| `repo-scout` | Repository Scout | worker | Read-only repository exploration worker for codebase mapping, file discovery, and pattern finding. |
| `research-analyst` | Research Analyst | worker | External research worker for docs, web, official sources, comparative analysis, and source-backed findings. |
| `verification-engineer` | Verification Engineer | worker | Acceptance gate worker for evidence review, real/local/sandbox verification, diff review, and approve/request-changes decisions. |

Do not introduce extra first-release agents such as `solution-architect`, `context-curator`, or similar unless they are strictly necessary. If additional behavior is needed, prefer plugin tools or internal helper modules instead of increasing the public roster.

### Technology choices

- The durable ledger must use a user-level state path by default; repositories track only `.opencode/orch.txt` for identity and keep `.opencode/state/` ignored.
- The default ledger backend must be SQLite, implemented in-repo without inventing an external service dependency.
- Orchestration tools must be plugin-owned custom tools exposed by this harness, not ad-hoc per-project `.opencode/tools` files.
- Existing runtime session/task maps may remain as helper caches for continuation hints, but the ledger must become the source of truth for mission state.
- Compaction support must be wired through the OpenCode compaction hook path, not simulated by prompt text alone.
- Writing work must default to single-writer behavior; read-only and research work may run in parallel when safe.

### Permission intent

- `mission-control` may directly read project files, grep the repo, edit files, patch files, or run implementation shell commands.
- `mission-control` must be able to delegate with `task`, ask user questions, and call orchestration tools.
- `repo-scout` must be read-only.
- `research-analyst` must be research-oriented and non-editing.
- `implementation-engineer` and `frontend-engineer` may edit inside assigned scope and may recursively spawn workers.
- `verification-engineer` must not edit files.

### Exact permission contract

The implementation should realize the permission model with behavior equivalent to the following intent:

- `mission-control`
  - deny: read, grep, glob/list-style repo inspection, edit/write/apply_patch, implementation bash
  - allow: task delegation to approved workers only, user questions, orchestration custom tools
- `repo-scout`
  - allow: read, grep, glob/list-style repo discovery
  - deny: edit/write/apply_patch, worker spawning
- `research-analyst`
  - allow: web/docs/research tooling, source gathering, optionally read-only repo context when explicitly needed
  - deny: repo edits, worker spawning
- `implementation-engineer`
  - allow: scoped repo edits, implementation shell commands, safe local verification commands
  - deny: worker spawning
- `frontend-engineer`
  - allow: scoped frontend edits, safe frontend verification commands
  - deny: worker spawning outside recommendation output
- `verification-engineer`
  - allow: read-only inspection, verification commands, browser/local/sandbox checks
  - deny: repo edits, worker spawning

The exact permission object shape may vary with OpenCode’s agent config API, but the resulting behavior must match this contract.

### Context-sharing model

- Agent-to-agent sharing must happen through curated ledger artifacts and context bundles.
- Raw child transcripts must not be injected by default.
- Mission Control must receive a compact mission snapshot every turn.
- Workers must receive only task-relevant mission/task/artifact/context-bundle data.

### Verification model

- No mock-by-default completion claims.
- Safe real verification must be preferred over mock verification.
- A worker `done` claim without evidence must reopen the task.
- Non-trivial code changes require `verification-engineer` approval before the mission can close.

### Required worker output contract

The implementation must enforce a structured worker report equivalent to this shape:

```json
{
  "task_id": "T-014",
  "status": "done | partial | blocked",
  "summary": "What was actually done",
  "files_changed": [
    {
      "path": "src/example.ts",
      "change": "short diff summary"
    }
  ],
  "acceptance_criteria": [
    {
      "criterion": "Real endpoint returns expected response",
      "met": true,
      "evidence": "GET /health returned 200",
      "verification_type": "real_request | local_test | unit_test | build | browser | db_read | manual_reasoning"
    }
  ],
  "verification": {
    "mode": "real | sandbox | local | mock | not_run",
    "commands_or_actions": ["bun test"],
    "result": "pass | fail | partial | blocked",
    "why_not_real": null
  },
  "artifacts": [
    {
      "type": "research | diff_summary | test_log | screenshot | api_response | decision_note",
      "title": "short title",
      "content": "compact evidence"
    }
  ],
  "context_for_next_agent": "Only the high-signal context another agent needs",
  "recommended_next_tasks": [],
  "blockers": [],
  "remaining_gaps": [],
  "confidence": "low | medium | high"
}
```

The verifier must use a stricter gate report equivalent to this shape:

```json
{
  "verdict": "approve | request-changes",
  "gate_status": "pass | fail",
  "checked_criteria": [
    {
      "task_id": "T-014",
      "criterion": "...",
      "met": true,
      "evidence_checked": "..."
    }
  ],
  "issues": [
    {
      "severity": "critical | warning | suggestion",
      "location": "file or behavior",
      "issue": "...",
      "why": "...",
      "fix": "..."
    }
  ],
  "checks_run": [],
  "unverified_claims": [],
  "tasks_to_reopen": []
}
```

### Real execution boundary

- Automatically allowed without unnecessary approval: local tests, builds, typechecks, sandbox actions, browser checks in local/sandbox/test environments, DB read-backs, and known read-only local/sandbox/test HTTP requests.
- Not automatically allowed: production writes, deploys, git push, destructive DB actions, billing, email/SMS, irreversible user-visible actions, or ambiguous external production calls.
- If approval is needed, the system must continue all other safe work first, then return blockers in one grouped user-facing packet.

### Developer credential mode

- If the user explicitly provides test or sandbox credentials, the system may write them into relevant local ignored env files such as `.env`, `.env.local`, or test fixture env files when needed for local execution.
- The system must not produce generic moralizing secret-refusal behavior in this local developer flow.
- The system must not commit, push, or expose those credentials in logs, artifacts, screenshots, or final replies.
- Final reporting must mask credential values by default.
- Writing credentials into tracked files is not the default; only do so if the user explicitly asks for that tracked-file behavior.

### Repo-specific cleanup requirements

- Update example config so it only references hook/config keys that the repo actually supports.
- Update README, agent matrix, rendered agent docs, and tests to the final roster and behavior.
- Remove or rewrite any prompt language that assumes the primary agent directly implements code.
- Remove stale character-first framing from public docs and prompts.

### Prompt contract requirements

The implementation must encode the following prompt-level rules, whether directly in prompts or through equivalent shared prompt builders:

- Mission Control never directly reads or writes project code.
- Workers are not mission owners.
- Workers may recursively spawn other workers.
- Workers must complete the assigned packet fully and return the required structured report.
- Real execution is preferred over mocks whenever safe.
- Missing evidence reopens tasks.
- Final completion is forbidden until the orchestration gate passes.
- Test or sandbox credentials provided by the user may be used in local ignored env files for developer execution, but must not be committed or exposed in final reporting.

### Explicit non-goals

The first-release implementation must not rely on any of the following as primary mechanisms:

- “Just make the prompt smarter” without durable state
- raw transcript sharing between workers as the default context-sharing mechanism
- prompt-only role separation without real permissions
- multi-writer-by-default editing
- mock-only completion claims for tasks that were safely verifiable in real/local/sandbox conditions
- phased PR assumptions in the implementation document

### Edge-case rules that must be preserved

- Workers do not recursively spawn workers.
- Project-level overlapping write-scope blocks are disabled.
- Blockers are batched, not surfaced piecemeal while safe work remains.
- Context compaction must not lose mission goal, open tasks, blockers, decisions, locks, or verification state.
- Final completion is forbidden while open tasks, unmet criteria, missing evidence, unresolved critical verifier issues, or skipped safe checks remain.

## Final implementation rule

This document now defines exactly one implementation unit: the single-round master implementation task above. There are no secondary phased tasks, no PR split assumptions, and no leftover parallel task list outside that master task.

## Final definition of done

The work is done only when the single-round master implementation task is fully complete, the repository matches that architecture, the relevant checks pass, and Mission Control cannot produce a final success response before all acceptance gates in that master task are satisfied.
